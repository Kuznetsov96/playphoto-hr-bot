import { describe, expect, it } from "vitest";
import { monthWindow, shiftKey, toMonthShifts } from "../schedule-month-context.js";

const KARAMEL = "33333333-3333-4333-8333-333333333333";

describe("schedule month context", () => {
    it("covers the whole calendar month", () => {
        expect(monthWindow("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
        expect(monthWindow("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
        expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    });

    it("reads instants in Kyiv time and builds the same key as an event snapshot", () => {
        const [row] = toMonthShifts(
            [{
                publicId: "55555555-5555-4555-8555-555555555555",
                locationPublicId: KARAMEL,
                localDate: "2026-10-12",
                startsAt: "2026-10-12T11:00:00.000Z",
                endsAt: "2026-10-12T17:00:00.000Z",
            }],
            [{ awsPublicId: KARAMEL, name: "Karamel", branch: "Atlant", city: "Sambir" }]
        );

        expect(row!.shift).toEqual({
            localDate: "2026-10-12",
            locationLabel: "Karamel (Atlant) (Sambir)",
            startsAtLocal: "14:00",
            endsAtLocal: "20:00",
        });
        expect(row!.key).toBe(shiftKey(KARAMEL, "2026-10-12", "14:00"));
    });

    it("refuses to show a shift whose location the bot does not know", () => {
        expect(() => toMonthShifts(
            [{
                publicId: "55555555-5555-4555-8555-555555555555",
                locationPublicId: KARAMEL,
                localDate: "2026-10-12",
                startsAt: "2026-10-12T11:00:00.000Z",
                endsAt: "2026-10-12T17:00:00.000Z",
            }],
            []
        )).toThrow("SCHEDULE_LOCATION_NOT_MAPPED");
    });
});
