import { InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { ADMIN_IDS } from "../config.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import {
    awsBusinessClient,
    type AwsReplacementNotification,
    type AwsReplacementNotificationPayload,
} from "./aws-business-client.js";

const MAX_FAILURE_REASON_LENGTH = 500;

/**
 * Just the client surface this dispatcher needs, so tests can supply a bare
 * mock instead of the full `AwsBusinessClient`.
 *
 * Deliberately a plain array, not the `{ items, invalidPublicIds,
 * unidentifiableCount }` envelope `AwsBusinessClient.pendingScheduleNotifications`
 * returns: row-level Zod validation already happened inside
 * `awsBusinessClient.pendingReplacementNotifications`, so by the time a row
 * reaches this dispatcher it is already a well-typed `AwsReplacementNotification`.
 * Rejected rows are the client's own concern to report, keeping this
 * dispatcher's contract — and its tests — simple.
 */
export interface ReplacementNotificationClient {
    pendingReplacementNotifications(limit: number): Promise<AwsReplacementNotification[]>;
    markReplacementNotificationDelivered(publicId: string): Promise<void>;
    markReplacementNotificationFailed(publicId: string, reason: string): Promise<void>;
}

const PENDING_LIMIT = 100;

/**
 * Reported for a row whose payload does not match the agreed contract, or
 * whose recipient cannot be resolved at all. A fixed code, deliberately
 * carrying no field names and no values from the payload.
 */
const INVALID_PAYLOAD_REASON = "REPLACEMENT_NOTIFICATION_PAYLOAD_INVALID";
const NO_RECIPIENT_REASON = "REPLACEMENT_NOTIFICATION_NO_RECIPIENT";
const NO_ADMIN_CONFIGURED_REASON = "REPLACEMENT_NOTIFICATION_NO_ADMIN_CONFIGURED";

/**
 * `ДД.ММ, дата` → the bot only ever receives the local wall-clock string, so
 * this reads it as text and never re-parses through `Date` — doing that would
 * reinterpret the string in the bot process's own timezone and shift what the
 * recipient sees.
 */
function formatLocalDay(localDateTime: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(localDateTime);
    return match ? `${match[3]}.${match[2]}` : "";
}

function formatLocalTime(localDateTime: string): string {
    const match = /[T ](\d{2}:\d{2})/u.exec(localDateTime);
    return match?.[1] ?? "";
}

function formatLocationLine(payload: AwsReplacementNotificationPayload): { location: string; date: string } {
    const location =
        payload.locationCity && payload.locationCity !== payload.locationName
            ? `${payload.locationName} (${payload.locationCity})`
            : payload.locationName;
    return { location, date: formatLocalDay(payload.startsAtLocal) };
}

/**
 * Renders every candidate-facing kind. `ACCEPTED_OWNER_REVIEW` is handled
 * separately in `renderOwnerReviewMessage` — its text depends on `outcome`,
 * not on `kind` alone, and it addresses the owner rather than the candidate.
 */
function renderCandidateMessage(row: AwsReplacementNotification): string | null {
    const { location, date } = formatLocationLine(row.payload);
    switch (row.kind) {
        case "OFFER": {
            const time = formatLocalTime(row.payload.startsAtLocal)
                ? `${formatLocalTime(row.payload.startsAtLocal)}-${formatLocalTime(row.payload.endsAtLocal)}`
                : "";
            return STAFF_TEXTS["staff-replacement-offer-unavailable-wave"]({ location, date, time });
        }
        case "OFFER_CLOSED":
            return STAFF_TEXTS["staff-replacement-offer-closed"]({ location, date });
        case "OFFER_REOPENED":
            return STAFF_TEXTS["staff-replacement-offer-reopened"]({ location, date });
        case "ACCEPTANCE_REVERTED":
            return STAFF_TEXTS["staff-replacement-reverted-by-owner"]({ location, date });
        case "ACCEPTED_OWNER_REVIEW":
            return null;
    }
}

/**
 * `outcome` decides the owner's message: `confirmed` means the shift already
 * moved and the owner only needs a revert button; `needs_review` means the
 * automatic checks failed and the owner must decide. Getting this backwards
 * tells the owner to review something already settled, so an unrecognised or
 * missing outcome is treated as `needs_review` — the more cautious reading —
 * rather than silently defaulting to "already handled".
 */
function renderOwnerReviewMessage(payload: AwsReplacementNotificationPayload): string {
    const { location, date } = formatLocationLine(payload);
    const time = `${formatLocalTime(payload.startsAtLocal)}-${formatLocalTime(payload.endsAtLocal)}`;
    const requesterName = payload.requesterDisplayName ?? "?";
    const candidateName = payload.candidateDisplayName ?? "?";
    return payload.outcome === "confirmed"
        ? STAFF_TEXTS["staff-replacement-owner-review-confirmed"]({
              requesterName,
              candidateName,
              location,
              date,
              time,
          })
        : STAFF_TEXTS["staff-replacement-owner-review-needs-review"]({
              requesterName,
              candidateName,
              location,
              date,
              time,
          });
}

/**
 * Signed-callback code for the owner's revert button. Exported so the
 * Telegram callback handler in `handlers/index.ts` matches on the exact same
 * string this dispatcher signs with, rather than a second hardcoded copy.
 */
export const REPLACEMENT_REVERT_CALLBACK_CODE = "replrv";

function buildOwnerReviewKeyboard(payload: AwsReplacementNotificationPayload): InlineKeyboard {
    return new InlineKeyboard().text(
        STAFF_TEXTS["staff-replacement-owner-review-btn-revert"],
        buildSignedCallback(REPLACEMENT_REVERT_CALLBACK_CODE, payload.replacementPublicId),
    );
}

/**
 * Maps any delivery error onto a short, non-PII reason code for the backend.
 * Same classification as the schedule-notification dispatcher, kept separate
 * rather than imported so the two outboxes never couple on a shared module.
 */
export function toSafeFailureReason(error: unknown): string {
    const description = error instanceof Error ? error.message : "";
    if (/blocked|deactivated|user is deactivated|bot was blocked/iu.test(description)) {
        return "TELEGRAM_RECIPIENT_UNREACHABLE";
    }
    if (/chat not found|user not found/iu.test(description)) {
        return "TELEGRAM_CHAT_NOT_FOUND";
    }
    if (/too many requests|429|flood/iu.test(description)) {
        return "TELEGRAM_RATE_LIMITED";
    }
    if (/timeout|aborted/iu.test(description)) {
        return "TELEGRAM_DELIVERY_TIMEOUT";
    }
    return "TELEGRAM_DELIVERY_FAILED";
}

export class ReplacementNotificationDispatcher {
    private readonly adminIds: number[];

    constructor(
        private readonly client: ReplacementNotificationClient,
        private readonly api: Pick<Api, "sendMessage">,
        options: { adminIds?: number[] } = {},
    ) {
        // Defaults to the bot's real admin list; a test may override it so it
        // never depends on process env for the owner-routing assertions.
        this.adminIds = options.adminIds ?? ADMIN_IDS;
    }

    /**
     * One dispatch pass: fetch the pending batch, send each row, report the
     * result. A single recipient's failure is caught and reported — it never
     * aborts the rest of the batch, mirroring the schedule-notification
     * dispatcher's guarantee.
     */
    async dispatchPending(): Promise<{ delivered: number; failed: number }> {
        const rows = await this.client.pendingReplacementNotifications(PENDING_LIMIT);

        let delivered = 0;
        let failed = 0;

        for (const row of rows) {
            const outcome = await this.deliverRow(row);
            if (outcome === "delivered") delivered += 1;
            else failed += 1;
        }

        return { delivered, failed };
    }

    private async deliverRow(row: AwsReplacementNotification): Promise<"delivered" | "failed"> {
        const target = this.resolveRecipient(row);
        if (target === null) {
            const reason = row.kind === "ACCEPTED_OWNER_REVIEW" ? NO_ADMIN_CONFIGURED_REASON : NO_RECIPIENT_REASON;
            logBusinessEvent({
                event: "bot.replacement_notifications.no_recipient",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: reason,
                module: "replacement-notification-dispatcher",
                operation: "deliverRow",
                safeContext: { kind: row.kind },
            });
            await this.report(row.publicId, () =>
                this.client.markReplacementNotificationFailed(row.publicId, reason),
            );
            return "failed";
        }

        const text =
            row.kind === "ACCEPTED_OWNER_REVIEW" ? renderOwnerReviewMessage(row.payload) : renderCandidateMessage(row);
        if (text === null) {
            // Unreachable in practice (every kind renders something), but a
            // future kind added to the backend enum without a bot-side text
            // must not crash the pass — the row is retried instead.
            await this.report(row.publicId, () =>
                this.client.markReplacementNotificationFailed(row.publicId, INVALID_PAYLOAD_REASON),
            );
            return "failed";
        }

        // `exactOptionalPropertyTypes` rejects an explicit `reply_markup:
        // undefined`, so the key is only added at all when there is a keyboard.
        const options: Parameters<Api["sendMessage"]>[2] =
            row.kind === "ACCEPTED_OWNER_REVIEW"
                ? { parse_mode: "HTML", reply_markup: buildOwnerReviewKeyboard(row.payload) }
                : { parse_mode: "HTML" };

        try {
            await this.api.sendMessage(target, text, options);
        } catch (error) {
            const reason = toSafeFailureReason(error).slice(0, MAX_FAILURE_REASON_LENGTH);
            logBusinessEvent({
                event: "bot.replacement_notifications.delivery_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: reason,
                module: "replacement-notification-dispatcher",
                operation: "deliverRow",
                safeContext: { kind: row.kind },
                error,
            });
            await this.report(row.publicId, () => this.client.markReplacementNotificationFailed(row.publicId, reason));
            return "failed";
        }

        logBusinessEvent({
            event: "bot.replacement_notifications.delivered",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "replacement-notification-dispatcher",
            operation: "deliverRow",
            safeContext: { kind: row.kind },
        });
        await this.report(row.publicId, () => this.client.markReplacementNotificationDelivered(row.publicId));
        return "delivered";
    }

    /**
     * `ACCEPTED_OWNER_REVIEW` never uses the row's own `telegramId`: that field
     * is the accepting candidate's Telegram id (the FK the row's `employeeId`
     * must point at), not the owner's. The backend has no `telegramId` on the
     * owner model at all — the bot is the only place that knows who the owner
     * is in Telegram, via its own admin list. Every other kind is candidate-
     * facing and uses the row's `telegramId` as-is.
     */
    private resolveRecipient(row: AwsReplacementNotification): number | null {
        if (row.kind === "ACCEPTED_OWNER_REVIEW") {
            const adminId = this.adminIds[0];
            return adminId ?? null;
        }
        if (row.telegramId === null) return null;
        return Number(row.telegramId);
    }

    /**
     * Reporting must never throw out of `dispatchPending`: a lost receipt only
     * means the backend re-offers the row later.
     */
    private async report(publicId: string, report: () => Promise<void>): Promise<void> {
        try {
            await report();
        } catch (error) {
            logBusinessEvent({
                event: "bot.replacement_notifications.report_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "REPORT_REQUEST_FAILED",
                module: "replacement-notification-dispatcher",
                operation: "report",
                safeContext: { publicId },
                error,
            });
        }
    }
}

/**
 * Adapts `awsBusinessClient` to the dispatcher's plain-array contract.
 *
 * `awsBusinessClient.pendingReplacementNotifications` validates each row with
 * Zod and separates out the ones that failed — exactly like
 * `pendingScheduleNotifications`. Rows a bad payload could not even be
 * identified by (`unidentifiableCount`) cannot be reported at all and are
 * only logged, the same gap `ScheduleNotificationDispatcher.reportInvalid`
 * accepts for the same reason.
 */
async function fetchPendingRows(limit: number): Promise<AwsReplacementNotification[]> {
    const pending = await awsBusinessClient.pendingReplacementNotifications(limit);

    for (const publicId of pending.invalidPublicIds) {
        logBusinessEvent({
            event: "bot.replacement_notifications.invalid_payload",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: INVALID_PAYLOAD_REASON,
            module: "replacement-notification-dispatcher",
            operation: "fetchPendingRows",
            safeContext: { publicId },
        });
        await awsBusinessClient
            .markReplacementNotificationFailed(publicId, INVALID_PAYLOAD_REASON)
            .catch((error) =>
                logBusinessEvent({
                    event: "bot.replacement_notifications.report_failed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    reasonCode: "REPORT_REQUEST_FAILED",
                    module: "replacement-notification-dispatcher",
                    operation: "fetchPendingRows",
                    safeContext: { publicId },
                    error,
                }),
            );
    }
    if (pending.unidentifiableCount > 0) {
        logBusinessEvent({
            event: "bot.replacement_notifications.invalid_payload",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: INVALID_PAYLOAD_REASON,
            module: "replacement-notification-dispatcher",
            operation: "fetchPendingRows",
            safeContext: { unidentifiableCount: pending.unidentifiableCount },
        });
    }

    return pending.items;
}

const awsReplacementNotificationClient: ReplacementNotificationClient = {
    pendingReplacementNotifications: fetchPendingRows,
    markReplacementNotificationDelivered: (publicId) =>
        awsBusinessClient.markReplacementNotificationDelivered(publicId),
    markReplacementNotificationFailed: (publicId, reason) =>
        awsBusinessClient.markReplacementNotificationFailed(publicId, reason),
};

/**
 * Builds a dispatcher wired to the real backend client, given the running
 * bot's `Api` (mirrors how `scheduleNotificationDispatcher.runOnce(bot.api)`
 * is called from the worker's poll loop). Poll-loop wiring itself — the
 * `setInterval` and its feature flag — is not part of this change; this
 * factory is what that wiring would call.
 */
export function createReplacementNotificationDispatcher(
    api: Pick<Api, "sendMessage">,
): ReplacementNotificationDispatcher {
    return new ReplacementNotificationDispatcher(awsReplacementNotificationClient, api);
}

/** Just the client surface the revert handler needs. */
export interface ReplacementRevertClient {
    revertReplacementAsOwner(
        requestPublicId: string,
        acknowledgeLateRevert: boolean,
    ): Promise<{ publicId: string; status: string }>;
}

export type ReplacementRevertOutcome = "reverted" | "denied" | "failed";

/**
 * The only check standing between the revert button and
 * `POST /internal/bot/replacements/{id}/revert`.
 *
 * The backend cannot verify who pressed the button: its service token proves
 * only "this is the bot", and there is no `telegramId` on the owner (`User`)
 * model to compare against (see Task 9's brief and
 * `revertReplacementAsOwner`'s own doc comment in `aws-business-client.ts`).
 * The bot is the only place that knows which Telegram ids are owners, via its
 * own `ADMIN_IDS` config — so this check MUST run, and MUST run before the
 * client call, every time this button is pressed. Skipping it would leave the
 * revert route reachable by anyone who can make the bot invoke it.
 *
 * Kept as a plain function (not folded into the grammy handler) precisely so
 * it can be unit tested without constructing a grammy `Context`: the required
 * test is "a non-admin id must never reach the API client", and that has to
 * be checkable without mocking Telegram's transport.
 */
export async function revertReplacementIfOwner(input: {
    telegramId: number | undefined;
    requestPublicId: string;
    acknowledgeLateRevert: boolean;
    client: ReplacementRevertClient;
    adminIds?: number[];
}): Promise<ReplacementRevertOutcome> {
    const adminIds = input.adminIds ?? ADMIN_IDS;

    // The gate: no client call happens on any path through this branch.
    if (input.telegramId === undefined || !adminIds.includes(input.telegramId)) {
        logBusinessEvent({
            event: "bot.replacement_notifications.revert_denied",
            level: "warn",
            actorType: "staff",
            actorRole: "staff",
            telegramId: input.telegramId,
            result: "failed",
            reasonCode: "NOT_AN_ADMIN",
            module: "replacement-notification-dispatcher",
            operation: "revertReplacementIfOwner",
        });
        return "denied";
    }

    try {
        await input.client.revertReplacementAsOwner(input.requestPublicId, input.acknowledgeLateRevert);
    } catch (error) {
        logBusinessEvent({
            event: "bot.replacement_notifications.revert_failed",
            level: "error",
            actorType: "staff",
            actorRole: "staff",
            telegramId: input.telegramId,
            result: "failed",
            reasonCode: "REVERT_REQUEST_FAILED",
            module: "replacement-notification-dispatcher",
            operation: "revertReplacementIfOwner",
            error,
        });
        return "failed";
    }

    logBusinessEvent({
        event: "bot.replacement_notifications.reverted",
        actorType: "staff",
        actorRole: "staff",
        telegramId: input.telegramId,
        result: "success",
        module: "replacement-notification-dispatcher",
        operation: "revertReplacementIfOwner",
    });
    return "reverted";
}
