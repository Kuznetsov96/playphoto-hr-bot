import type { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent, logSecurityEvent } from "../core/log-events.js";
import { accessService } from "./access-service.js";
import { awsBusinessClient, type AwsAccessRevocationRow } from "./aws-business-client.js";

const PENDING_LIMIT = 100;
const MAX_FAILURE_REASON_LENGTH = 500;

/**
 * Drains Task 5's access-revocation queue: REVOKE rows lose channel/hub/support
 * access, RESTORE rows get a fresh one-time invite link. Modeled on
 * `schedule-notification-dispatcher.ts` — a polling loop behind an env flag,
 * each row in its own try/catch so one bad row never stalls the rest of the
 * queue, and acknowledgement calls are safe to retry since the API side is
 * idempotent on them.
 */
export async function runAccessRevocations(bot: Pick<Bot<MyContext>, "api">): Promise<void> {
    let pending: { items: AwsAccessRevocationRow[] };
    try {
        pending = await awsBusinessClient.pendingAccessRevocations(PENDING_LIMIT);
    } catch (error) {
        logBusinessEvent({
            event: "bot.access_revocations.iteration_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "PENDING_FETCH_FAILED",
            module: "access-revocation-dispatcher",
            operation: "runAccessRevocations",
            error,
        });
        return;
    }

    if (pending.items.length === 0) return;

    for (const row of pending.items) {
        await processRow(bot, row);
    }

    logBusinessEvent({
        event: "bot.access_revocations.iteration_completed",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "access-revocation-dispatcher",
        operation: "runAccessRevocations",
        safeContext: { pendingCount: pending.items.length },
    });
}

async function processRow(
    bot: Pick<Bot<MyContext>, "api">,
    row: AwsAccessRevocationRow,
): Promise<void> {
    const telegramId = BigInt(row.telegramId);

    try {
        if (row.kind === "REVOKE") {
            await accessService.revokeAccess(telegramId, row.reason);
        } else {
            await processRestore(bot, telegramId, row);
        }
    } catch (error) {
        const reason = toFailureReason(error);
        logBusinessEvent({
            event: "bot.access_revocations.row_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            telegramId: row.telegramId,
            result: "failed",
            reasonCode: reason,
            module: "access-revocation-dispatcher",
            operation: "processRow",
            safeContext: { publicId: row.publicId, kind: row.kind },
            error,
        });
        await report(row.publicId, () =>
            awsBusinessClient.markAccessRevocationFailed(row.publicId, reason.slice(0, MAX_FAILURE_REASON_LENGTH)),
        );
        return;
    }

    logBusinessEvent({
        event: "bot.access_revocations.row_processed",
        actorType: "system",
        actorRole: "system",
        telegramId: row.telegramId,
        result: "success",
        module: "access-revocation-dispatcher",
        operation: "processRow",
        safeContext: { publicId: row.publicId, kind: row.kind },
    });
    await report(row.publicId, () => awsBusinessClient.markAccessRevocationProcessed(row.publicId));
}

/**
 * RESTORE succeeds the moment access itself is back — `createInviteLink`
 * already cleared the ban, so the person can rejoin via `accessService`'s
 * static join link even if this specific message never lands. The row is
 * therefore acknowledged as processed even when the delivery step below
 * fails; delivery failure is only ever logged as a security event so the
 * owner can see, on the person's own record, that access was restored but
 * the one-time link may not have reached them (most commonly because they
 * had blocked the bot — the same condition that caused the REVOKE in the
 * first place). Marking the whole row `failed` instead would make the API
 * re-offer it forever, repeatedly minting and burning one-time links for
 * someone who already has access.
 */
async function processRestore(
    bot: Pick<Bot<MyContext>, "api">,
    telegramId: bigint,
    row: AwsAccessRevocationRow,
): Promise<void> {
    const link = await accessService.createInviteLink(telegramId);
    if (!link) {
        logSecurityEvent({
            event: "bot.access_revocations.restore_not_authorized",
            actorType: "system",
            actorRole: "system",
            telegramId: row.telegramId,
            result: "failed",
            reasonCode: "RESTORE_NOT_AUTHORIZED",
            module: "access-revocation-dispatcher",
            operation: "processRestore",
            safeContext: { publicId: row.publicId },
        });
        return;
    }

    try {
        await bot.api.sendMessage(Number(telegramId), STAFF_TEXTS["access-restore-invite"]({ link }), {
            parse_mode: "HTML",
        });
    } catch (error) {
        logSecurityEvent({
            event: "bot.access_revocations.restore_link_undelivered",
            actorType: "system",
            actorRole: "system",
            telegramId: row.telegramId,
            result: "failed",
            reasonCode: toFailureReason(error),
            module: "access-revocation-dispatcher",
            operation: "processRestore",
            safeContext: { publicId: row.publicId },
            error,
        });
    }
}

/**
 * Maps a delivery/API error onto a short reason the backend can store. Kept
 * as the error's own message (unlike the schedule dispatcher's fixed codes)
 * because the brief's test asserts on `expect.stringContaining('blocked')` —
 * the owner reading a failed REVOKE row needs to see *why* revocation
 * itself failed, not just a generic code.
 */
function toFailureReason(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * Reporting must never abort the pass: a lost acknowledgement only means the
 * backend re-offers the row later, and the API side is documented as
 * idempotent on both `/processed` and `/failed`.
 */
async function report(publicId: string, send: () => Promise<void>): Promise<void> {
    try {
        await send();
    } catch (error) {
        logBusinessEvent({
            event: "bot.access_revocations.report_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "REPORT_REQUEST_FAILED",
            module: "access-revocation-dispatcher",
            operation: "report",
            safeContext: { publicId },
            error,
        });
    }
}

/** Test-only entry point, mirroring `scheduleNotificationDispatcher.runOnce`. */
export const runAccessRevocationsForTest = runAccessRevocations;
