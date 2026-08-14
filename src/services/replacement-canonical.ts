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
