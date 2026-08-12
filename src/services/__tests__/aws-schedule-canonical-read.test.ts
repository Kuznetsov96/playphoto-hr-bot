import { describe, expect, it } from "vitest";
import { CanonicalScheduleReadError, projectCanonicalSchedule } from "../aws-schedule-canonical-projector.js";

const canonicalShift = {
    publicId: "33333333-3333-4333-8333-333333333333",
    locationPublicId: "11111111-1111-4111-8111-111111111111",
    localDate: "2026-08-10",
    startsAt: "2026-08-10T08:00:00.000Z",
    endsAt: "2026-08-10T17:00:00.000Z"
};

const location = {
    id: "local-location",
    awsPublicId: canonicalShift.locationPublicId,
    name: "Canonical location mapping",
    branch: "Shevchyk",
    schedule: "10:00-20:00",
    openingHours: [{ dayOfWeek: 1, opens: "14:00", closes: "21:00" }]
};

const projection = {
    id: "local-shift",
    awsScheduledShiftPublicId: canonicalShift.publicId
};

describe("projectCanonicalSchedule", () => {
    it("uses canonical business fields while preserving local technical identities", () => {
        expect(projectCanonicalSchedule("staff-1", [canonicalShift], [location], [projection])).toEqual([{
            id: projection.id,
            staffId: "staff-1",
            locationId: location.id,
            date: new Date("2026-08-10T00:00:00.000Z"),
            startTime: new Date(canonicalShift.startsAt),
            endTime: new Date(canonicalShift.endsAt),
            location: {
                id: location.id,
                name: location.name,
                branch: location.branch,
                schedule: location.schedule,
                openingHours: location.openingHours
            }
        }]);
    });

    it("refuses a partial location mapping instead of returning mixed-source data", () => {
        expect(() => projectCanonicalSchedule("staff-1", [canonicalShift], [], [projection]))
            .toThrowError(new CanonicalScheduleReadError("LOCATION_NOT_MAPPED"));
    });

    it("requires the technical shift projection needed by Telegram replacement state", () => {
        expect(() => projectCanonicalSchedule("staff-1", [canonicalShift], [location], []))
            .toThrowError(new CanonicalScheduleReadError("SHIFT_PROJECTION_NOT_MAPPED"));
    });
});
