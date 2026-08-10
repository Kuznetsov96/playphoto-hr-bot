import { beforeEach, describe, expect, it, vi } from "vitest";

const logBusinessEvent = vi.fn();
const previewReplacement = vi.fn();
const resolveCanonicalShift = vi.fn();

vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: (...args: unknown[]) => logBusinessEvent(...args)
}));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { previewReplacement: (...args: unknown[]) => previewReplacement(...args) }
}));
vi.mock("../canonical-shift-resolver.js", () => ({
    resolveCanonicalShift: (...args: unknown[]) => resolveCanonicalShift(...args)
}));
vi.mock("../../config.js", () => ({
    AWS_REPLACEMENTS_SHADOW_ENABLED: true,
    BUSINESS_DATA_SOURCE: "aws"
}));

const { replacementShadowService } = await import("../replacement-shadow.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function input(overrides: Record<string, unknown> = {}) {
    return {
        requestId: `request-${Math.random()}`,
        workShiftId: "work-shift-1",
        requesterStaffId: "staff-1",
        requesterTelegramId: "12345",
        locationId: "location-1",
        shiftDate: new Date("2026-08-15T00:00:00.000Z"),
        legacyCandidates: [{ awsEmployeePublicId: "emp-1", availabilityKind: "LIMITED" }],
        wave: "SAME_LOCATION_AVAILABLE",
        ...overrides
    };
}

beforeEach(() => {
    logBusinessEvent.mockReset();
    previewReplacement.mockReset();
    resolveCanonicalShift.mockReset();
    resolveCanonicalShift.mockResolvedValue({
        ok: true,
        scheduledShiftPublicId: "shift-uuid",
        employeePublicId: "emp-uuid"
    });
});

describe("replacementShadowService", () => {
    it("logs the expected LIMITED divergence without leaking identifiers", async () => {
        previewReplacement.mockResolvedValue({
            waves: [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                }
            ]
        });

        replacementShadowService.compareInBackground(input());
        await flush();

        const event = logBusinessEvent.mock.calls.at(-1)![0];
        expect(event.event).toBe("bot.replacement_shadow.compared");
        expect(event.result).toBe("mismatch");
        expect(event.safeContext.limitedOnlyInLegacyCount).toBe(1);
        expect(JSON.stringify(event)).not.toContain("emp-1");
        expect(JSON.stringify(event)).not.toContain("12345");
    });

    it("compares only the canonical wave with the same name as the one legacy searched", async () => {
        // The canonical preview has a matching candidate, but only in a
        // DIFFERENT wave than the one legacy just searched. Flattening every
        // canonical wave (the pre-fix behaviour) would report a match here;
        // comparing like-for-like must not.
        previewReplacement.mockResolvedValue({
            waves: [
                { wave: "SAME_LOCATION_AVAILABLE", candidates: [] },
                {
                    wave: "SAME_CITY_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "LIMITED" }]
                }
            ]
        });

        replacementShadowService.compareInBackground(input({ wave: "SAME_LOCATION_AVAILABLE" }));
        await flush();

        const event = logBusinessEvent.mock.calls.at(-1)![0];
        expect(event.event).toBe("bot.replacement_shadow.compared");
        expect(event.result).toBe("mismatch");
        expect(event.safeContext.canonicalWaveFound).toBe(true);
        expect(event.safeContext.missingInCanonicalCount).toBe(1);
        expect(event.safeContext.canonicalCount).toBe(0);
    });

    it("reports a wave-name mismatch as a distinct, visible failure instead of an empty set", async () => {
        // The canonical preview has waves, but none named after the wave legacy
        // searched — a genuine contract/naming mismatch, not "canonical found
        // nobody". It must be counted and logged, not silently swallowed.
        previewReplacement.mockResolvedValue({
            waves: [
                { wave: "SAME_CITY_AVAILABLE", candidates: [] }
            ]
        });

        replacementShadowService.compareInBackground(input({ wave: "SAME_LOCATION_AVAILABLE" }));
        await flush();

        const event = logBusinessEvent.mock.calls.at(-1)![0];
        expect(event.event).toBe("bot.replacement_shadow.compared");
        expect(event.result).toBe("mismatch");
        expect(event.reasonCode).toBe("REPLACEMENT_CANONICAL_WAVE_NOT_FOUND");
        expect(event.safeContext.canonicalWaveFound).toBe(false);
    });

    it("skips and logs a reason when the shift cannot be resolved", async () => {
        resolveCanonicalShift.mockResolvedValue({ ok: false, reasonCode: "AMBIGUOUS_SHIFT" });

        replacementShadowService.compareInBackground(input());
        await flush();

        expect(previewReplacement).not.toHaveBeenCalled();
        const event = logBusinessEvent.mock.calls.at(-1)![0];
        expect(event.event).toBe("bot.replacement_shadow.skipped");
        expect(event.reasonCode).toBe("AMBIGUOUS_SHIFT");
    });

    it("never rejects when the canonical preview fails", async () => {
        previewReplacement.mockRejectedValue(new Error("boom"));

        expect(() => replacementShadowService.compareInBackground(input())).not.toThrow();
        await flush();

        const event = logBusinessEvent.mock.calls.at(-1)![0];
        expect(event.event).toBe("bot.replacement_shadow.failed");
    });

    it("applies a cooldown per request", async () => {
        previewReplacement.mockResolvedValue({ waves: [] });
        const shared = input();

        replacementShadowService.compareInBackground(shared);
        await flush();
        replacementShadowService.compareInBackground(shared);
        await flush();

        expect(previewReplacement).toHaveBeenCalledTimes(1);
    });

    it("suppresses within the cooldown window but prunes and re-runs once it elapses", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            previewReplacement.mockResolvedValue({ waves: [] });
            const first = input({ requestId: "request-a" });

            replacementShadowService.compareInBackground(first);
            await flush();
            expect(previewReplacement).toHaveBeenCalledTimes(1);

            // Still inside the 5-minute cooldown window: repeat call is suppressed.
            vi.setSystemTime(Date.now() + 4 * 60 * 1000);
            replacementShadowService.compareInBackground(first);
            await flush();
            expect(previewReplacement).toHaveBeenCalledTimes(1);

            // Past the cooldown window: a call for a different request triggers
            // pruning of the stale "request-a" entry.
            vi.setSystemTime(Date.now() + 2 * 60 * 1000);
            const second = input({ requestId: "request-b" });
            replacementShadowService.compareInBackground(second);
            await flush();
            expect(previewReplacement).toHaveBeenCalledTimes(2);

            // "request-a" is no longer in the cooldown map, so it must run again.
            replacementShadowService.compareInBackground(first);
            await flush();
            expect(previewReplacement).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});
