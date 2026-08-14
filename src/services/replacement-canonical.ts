import { logBusinessEvent } from "../core/log-events.js";
import { awsBusinessClient } from "./aws-business-client.js";
import {
    resolveCanonicalShift,
    type CanonicalShiftResolveReason,
} from "./canonical-shift-resolver.js";

export type CanonicalReplacementFailure =
    | CanonicalShiftResolveReason
    | "CANONICAL_BACKEND_UNAVAILABLE";

export type CanonicalReplacementResult =
    | { ok: true; replacementPublicId: string }
    | { ok: false; reasonCode: CanonicalReplacementFailure };

/**
 * Creates a replacement request through the canonical backend. This is the
 * source-of-truth write path when `AWS_REPLACEMENTS_CANONICAL_ENABLED` is on:
 * callers must not fall back to a local-only request on failure, since that
 * would recreate the split-brain state this migration removes.
 */
export async function startCanonicalReplacement(input: {
    workShiftId: string | null;
    requesterStaffId: string | null;
    requesterTelegramId: string;
    locationId: string;
    shiftDate: Date;
}): Promise<CanonicalReplacementResult> {
    const resolution = await resolveCanonicalShift({
        workShiftId: input.workShiftId,
        requesterStaffId: input.requesterStaffId,
        locationId: input.locationId,
        shiftDate: input.shiftDate,
    });
    if (!resolution.ok) return { ok: false, reasonCode: resolution.reasonCode };

    try {
        const created = await awsBusinessClient.createReplacement({
            scheduledShiftPublicId: resolution.scheduledShiftPublicId,
            requesterEmployeePublicId: resolution.employeePublicId,
            requesterTelegramId: input.requesterTelegramId,
        });
        return { ok: true, replacementPublicId: created.publicId };
    } catch (error: unknown) {
        logBusinessEvent({
            event: "bot.replacement_canonical.failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
            module: "replacement-canonical",
            operation: "create",
            safeContext: {
                errorType: error instanceof Error ? error.constructor.name : "UnknownError",
            },
        });
        return { ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" };
    }
}

export type CanonicalWaveResult =
    | { ok: true; status: string; nextWaveAt: Date | null }
    | { ok: false; reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" };

/**
 * Asks the canonical backend to run the next wave for a request.
 *
 * Candidate selection lives there: it owns the wave policy, decides who to ask,
 * records an OFFER notification per candidate, and paces when the next wave is
 * due. The bot's remaining job is to poll on time and let the notification
 * dispatcher deliver whatever came out — it does not choose who is offered a
 * shift, and must not fall back to choosing locally when this fails.
 *
 * A local fallback would offer the shift to people the backend never recorded,
 * leaving the two sides disagreeing about who was even asked. Reporting the
 * failure instead lets the caller retry the same canonical dispatch later.
 */
export async function dispatchCanonicalWave(replacementPublicId: string): Promise<CanonicalWaveResult> {
    try {
        const view = await awsBusinessClient.dispatchReplacementWave(replacementPublicId);
        return {
            ok: true,
            status: view.status,
            nextWaveAt: view.nextWaveAt ? new Date(view.nextWaveAt) : null,
        };
    } catch (error: unknown) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? String((error as { code: unknown }).code)
                : undefined;

        /**
         * Polling early is ordinary: the backend paces the waves, so it answers
         * with the time this one is actually due. Treating that as a failure
         * would either drop the request or spin on it.
         */
        if (code === "REPLACEMENT_WAVE_NOT_DUE") {
            const dueAt =
                typeof error === "object" && error !== null && "nextWaveAt" in error
                    ? (error as { nextWaveAt?: unknown }).nextWaveAt
                    : undefined;
            return {
                ok: true,
                status: "ACTIVE",
                nextWaveAt: typeof dueAt === "string" ? new Date(dueAt) : null,
            };
        }

        logBusinessEvent({
            event: "bot.replacement_canonical.wave_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: code ?? "CANONICAL_BACKEND_UNAVAILABLE",
            module: "replacement-canonical",
            operation: "dispatchWave",
            safeContext: {
                errorType: error instanceof Error ? error.constructor.name : "UnknownError",
            },
        });
        return { ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" };
    }
}
