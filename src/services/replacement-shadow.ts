import { AWS_REPLACEMENTS_SHADOW_ENABLED, BUSINESS_DATA_SOURCE } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { awsBusinessClient } from "./aws-business-client.js";
import { resolveCanonicalShift } from "./canonical-shift-resolver.js";
import { compareReplacementCandidates, type LegacyCandidate } from "./replacement-shadow-compare.js";

const SHADOW_COMPARE_COOLDOWN_MS = 5 * 60 * 1000;

export interface ReplacementShadowInput {
    requestId: string;
    workShiftId: string | null;
    requesterStaffId: string | null;
    requesterTelegramId: string;
    locationId: string;
    shiftDate: Date;
    legacyCandidates: LegacyCandidate[];
    /** Name of the wave `legacyCandidates` was searched for — compared against the canonical wave of the same name, not the flattened union of all canonical waves. */
    wave: string;
}

export class ReplacementShadowService {
    private readonly lastStartedAt = new Map<string, number>();

    compareInBackground(input: ReplacementShadowInput): void {
        if (BUSINESS_DATA_SOURCE !== "aws" || !AWS_REPLACEMENTS_SHADOW_ENABLED) return;
        const now = Date.now();
        this.pruneStale(now);
        const lastStartedAt = this.lastStartedAt.get(input.requestId) ?? 0;
        if (now - lastStartedAt < SHADOW_COMPARE_COOLDOWN_MS) return;
        this.lastStartedAt.set(input.requestId, now);

        void this.compare(input).catch((error: unknown) => {
            logBusinessEvent({
                event: "bot.replacement_shadow.failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "CANONICAL_REPLACEMENT_UNAVAILABLE",
                module: "replacement-shadow",
                operation: "compare",
                safeContext: {
                    errorType: error instanceof Error ? error.constructor.name : "UnknownError"
                }
            });
        });
    }

    private pruneStale(now: number): void {
        for (const [requestId, startedAt] of this.lastStartedAt) {
            if (now - startedAt >= SHADOW_COMPARE_COOLDOWN_MS) {
                this.lastStartedAt.delete(requestId);
            }
        }
    }

    private async compare(input: ReplacementShadowInput): Promise<void> {
        const startedAt = Date.now();
        const resolution = await resolveCanonicalShift({
            workShiftId: input.workShiftId,
            requesterStaffId: input.requesterStaffId,
            locationId: input.locationId,
            shiftDate: input.shiftDate
        });

        if (!resolution.ok) {
            logBusinessEvent({
                event: "bot.replacement_shadow.skipped",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "skipped",
                reasonCode: resolution.reasonCode,
                module: "replacement-shadow",
                operation: "compare"
            });
            return;
        }

        const preview = await awsBusinessClient.previewReplacement({
            scheduledShiftPublicId: resolution.scheduledShiftPublicId,
            requesterEmployeePublicId: resolution.employeePublicId,
            requesterTelegramId: input.requesterTelegramId
        });

        const comparison = compareReplacementCandidates(input.legacyCandidates, preview.waves, input.wave);
        const reasonCode = comparison.parity
            ? undefined
            : comparison.canonicalWaveFound
                ? "REPLACEMENT_CANDIDATE_MISMATCH"
                : "REPLACEMENT_CANONICAL_WAVE_NOT_FOUND";

        logBusinessEvent({
            event: "bot.replacement_shadow.compared",
            level: comparison.parity ? "info" : "warn",
            actorType: "system",
            actorRole: "system",
            result: comparison.parity ? "parity" : "mismatch",
            reasonCode,
            module: "replacement-shadow",
            operation: "compare",
            durationMs: Date.now() - startedAt,
            safeContext: { waveCount: preview.waves.length, ...comparison }
        });
    }
}

export const replacementShadowService = new ReplacementShadowService();
