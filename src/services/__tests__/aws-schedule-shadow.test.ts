import { describe, expect, it } from "vitest";
import type { Location, WorkShift } from "@prisma/client";
import { compareScheduleProjection } from "../aws-schedule-shadow-compare.js";

const location = {
    awsPublicId: "11111111-1111-4111-8111-111111111111"
} as Location;

function legacy(overrides: Partial<WorkShift> = {}) {
    return {
        id: "legacy-shift",
        awsScheduledShiftPublicId: "33333333-3333-4333-8333-333333333333",
        staffId: "staff-1",
        locationId: "location-1",
        date: new Date("2026-08-10T00:00:00.000Z"),
        startTime: new Date("2026-08-10T08:00:00.000Z"),
        endTime: new Date("2026-08-10T17:00:00.000Z"),
        location,
        ...overrides
    } as WorkShift & { location: Location };
}

const canonical = {
    publicId: "33333333-3333-4333-8333-333333333333",
    locationPublicId: "11111111-1111-4111-8111-111111111111",
    localDate: "2026-08-10",
    startsAt: "2026-08-10T08:00:00.000Z",
    endsAt: "2026-08-10T17:00:00.000Z"
};

describe("compareScheduleProjection", () => {
    it("reports parity when canonical public IDs and fields match", () => {
        expect(compareScheduleProjection([legacy()], [canonical])).toEqual({
            parity: true,
            legacyCount: 1,
            canonicalCount: 1,
            matchedCount: 1,
            changedCount: 0,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 0
        });
    });

    it("reports changed, missing, and unmapped records without logging identifiers", () => {
        const result = compareScheduleProjection(
            [
                legacy({ endTime: new Date("2026-08-10T18:00:00.000Z") }),
                legacy({ id: "unmapped", awsScheduledShiftPublicId: null })
            ],
            [canonical, { ...canonical, publicId: "44444444-4444-4444-8444-444444444444" }]
        );

        expect(result).toEqual({
            parity: false,
            legacyCount: 2,
            canonicalCount: 2,
            matchedCount: 0,
            changedCount: 1,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 1,
            unmappedLegacyCount: 1
        });
    });
});
