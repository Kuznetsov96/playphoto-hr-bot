import prisma from "../db/core.js";
import { logBusinessEvent } from "../core/log-events.js";
import { awsBusinessClient } from "./aws-business-client.js";

export interface PreferenceDay {
    localDate: string;
    kind: "UNAVAILABLE";
}

/**
 * The bot asks photographers which days they CANNOT work, so every marked
 * day is submitted as UNAVAILABLE. PREFER_NOT_TO_WORK is never sent — that
 * distinction was lost in an earlier import and this restores it.
 */
export function buildPreferenceDays(month: string, dayNumbers: number[]): PreferenceDay[] {
    return [...dayNumbers]
        .sort((a, b) => a - b)
        .map((day) => ({
            localDate: `${month}-${String(day).padStart(2, "0")}`,
            kind: "UNAVAILABLE" as const,
        }));
}

export type CanonicalPreferenceReasonCode =
    | "EMPLOYEE_NOT_MAPPED"
    | "CANONICAL_PREFERENCE_READ_FAILED"
    | "CANONICAL_PREFERENCE_STALE_VERSION"
    | "CANONICAL_BACKEND_UNAVAILABLE";

export type CanonicalPreferenceResult =
    | { ok: true }
    | { ok: false; reasonCode: CanonicalPreferenceReasonCode };

/**
 * A 409 from the write endpoint means another writer changed the submission
 * between our read and our write — a normal concurrent-edit outcome, not an
 * outage. The shared `request()` helper discards the response body (and with
 * it the backend's `SCHEDULE_PREFERENCE_STALE_VERSION` code) before throwing,
 * so the HTTP status baked into the thrown Error's message is the only signal
 * left. That is enough to tell a 409 apart from other failures without
 * reshaping `request()` itself.
 */
function isStaleVersionConflict(error: unknown): boolean {
    return error instanceof Error && /HTTP 409\b/.test(error.message);
}

export async function saveCanonicalPreference(input: {
    staffId: string;
    month: string;
    selectedDays: number[];
    comment: string | null;
    telegramId: string;
    declined: boolean;
}): Promise<CanonicalPreferenceResult> {
    const staff = await prisma.staffProfile.findUnique({
        where: { id: input.staffId },
        select: { awsEmployeePublicId: true },
    });
    if (!staff?.awsEmployeePublicId) return { ok: false, reasonCode: "EMPLOYEE_NOT_MAPPED" };

    // The backend rejects a write against an existing submission unless the
    // current version is echoed back, and the bot supports re-filling a
    // month. Omitting the version is only valid for the very first
    // submission, so the current version is read first. The same telegramId
    // is used for both calls — the backend validates the GET's telegramId
    // against the employee's stored one (404 on mismatch), so reusing it for
    // the PUT is what makes the version read meaningful.
    let existing: Awaited<ReturnType<typeof awsBusinessClient.getSchedulePreference>>;
    try {
        existing = await awsBusinessClient.getSchedulePreference(
            staff.awsEmployeePublicId,
            input.month,
            input.telegramId,
        );
    } catch (error: unknown) {
        return logAndFail(error, "read", "CANONICAL_PREFERENCE_READ_FAILED", input.selectedDays.length);
    }

    try {
        await awsBusinessClient.upsertSchedulePreference(staff.awsEmployeePublicId, input.month, {
            status: input.declined ? "DECLINED" : "SUBMITTED",
            days: input.declined ? [] : buildPreferenceDays(input.month, input.selectedDays),
            ...(input.comment ? { comment: input.comment.slice(0, 500) } : {}),
            telegramId: input.telegramId,
            ...(existing.exists ? { version: existing.version } : {}),
        });
        return { ok: true };
    } catch (error: unknown) {
        const reasonCode = isStaleVersionConflict(error)
            ? "CANONICAL_PREFERENCE_STALE_VERSION"
            : "CANONICAL_BACKEND_UNAVAILABLE";
        return logAndFail(error, "upsert", reasonCode, input.selectedDays.length);
    }
}

/** Logs the failed call with the reason it actually failed for, then returns the same reason to the caller. */
function logAndFail(
    error: unknown,
    operation: "read" | "upsert",
    reasonCode: CanonicalPreferenceReasonCode,
    dayCount: number,
): { ok: false; reasonCode: CanonicalPreferenceReasonCode } {
    logBusinessEvent({
        event: "bot.canonical_preferences_write.failed",
        level: "error",
        actorType: "system",
        actorRole: "system",
        result: "failed",
        reasonCode,
        module: "canonical-preferences-writer",
        operation,
        safeContext: {
            errorType: error instanceof Error ? error.constructor.name : "UnknownError",
            dayCount,
        },
    });
    return { ok: false, reasonCode };
}
