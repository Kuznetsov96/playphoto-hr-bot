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

export type CanonicalPreferenceResult =
    | { ok: true }
    | { ok: false; reasonCode: "EMPLOYEE_NOT_MAPPED" | "CANONICAL_BACKEND_UNAVAILABLE" };

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

    try {
        // The backend rejects a write against an existing submission unless the
        // current version is echoed back, and the bot supports re-filling a
        // month. Omitting the version is only valid for the very first
        // submission, so the current version is read first. The same
        // telegramId is used for both calls — the backend validates the GET's
        // telegramId against the employee's stored one (404 on mismatch), so
        // reusing it for the PUT is what makes the version read meaningful.
        const existing = await awsBusinessClient.getSchedulePreference(
            staff.awsEmployeePublicId,
            input.month,
            input.telegramId,
        );

        await awsBusinessClient.upsertSchedulePreference(staff.awsEmployeePublicId, input.month, {
            status: input.declined ? "DECLINED" : "SUBMITTED",
            days: input.declined ? [] : buildPreferenceDays(input.month, input.selectedDays),
            ...(input.comment ? { comment: input.comment.slice(0, 500) } : {}),
            telegramId: input.telegramId,
            ...(existing.exists ? { version: existing.version } : {}),
        });
        return { ok: true };
    } catch (error: unknown) {
        logBusinessEvent({
            event: "bot.canonical_preferences_write.failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
            module: "canonical-preferences-writer",
            operation: "upsert",
            safeContext: {
                errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                dayCount: input.selectedDays.length,
            },
        });
        return { ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" };
    }
}
