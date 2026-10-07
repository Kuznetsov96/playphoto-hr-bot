import { describe, expect, it } from "vitest";
import { clip, dayLabel, dayMonth, formatDuration, formatIntervals, fromYymmdd, toYymmdd, ukWeekday } from "../shoot-format.js";

/**
 * Обидва боки від UTC: у Kiritimati (UTC+14) помиляється `new Date(y, m, d).getUTCDay()`,
 * у Los Angeles (UTC−7/−8) — `new Date("YYYY-MM-DD").getDay()`. Правильна функція
 * однакова в обох.
 */
const ZONES = ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"] as const;

describe("shoot format", () => {
    it("reads the weekday from the string, whatever the process timezone", () => {
        const previous = process.env.TZ;
        try {
            for (const zone of ZONES) {
                process.env.TZ = zone;
                expect([zone, ukWeekday("2030-03-16")]).toEqual([zone, "сб"]);
                expect([zone, ukWeekday("2030-03-17")]).toEqual([zone, "нд"]);
                expect([zone, dayLabel("2030-03-16")]).toEqual([zone, "сб 16.03"]);
            }
        } finally {
            if (previous === undefined) delete process.env.TZ;
            else process.env.TZ = previous;
        }
    });

    it("names every weekday in lowercase", () => {
        const week = ["2030-03-11", "2030-03-12", "2030-03-13", "2030-03-14", "2030-03-15", "2030-03-16", "2030-03-17"];
        expect(week.map(ukWeekday)).toEqual(["пн", "вт", "ср", "чт", "пт", "сб", "нд"]);
    });

    it("writes the day and month as ДД.ММ", () => {
        expect(dayMonth("2030-03-06")).toBe("06.03");
        expect(dayLabel("2030-12-01")).toBe("нд 01.12");
    });

    it("joins intervals with a short dash and commas", () => {
        expect(formatIntervals([{ start: "11:00", end: "12:00" }, { start: "15:00", end: null }])).toBe("11:00–12:00, 15:00");
    });

    it("says the duration in hours and minutes", () => {
        expect([30, 60, 90, 120, 75].map(formatDuration)).toEqual(["30 хв", "1 год", "1,5 год", "2 год", "1 год 15 хв"]);
    });

    it("packs a date into six digits and back, refusing impossible dates", () => {
        expect(toYymmdd("2030-03-16")).toBe("300316");
        expect(fromYymmdd("300316")).toBe("2030-03-16");
        expect(fromYymmdd("300230")).toBeNull();
        expect(fromYymmdd("3003")).toBeNull();
        expect(() => toYymmdd("16.03.2030")).toThrow();
    });

    it("clips long free text with an ellipsis", () => {
        expect(clip("а".repeat(600))).toHaveLength(500);
        expect(clip("а".repeat(600)).endsWith("…")).toBe(true);
        expect(clip("а".repeat(500))).toBe("а".repeat(500));
        expect(clip("коротко")).toBe("коротко");
    });

    it("never cuts an emoji in half when clipping", () => {
        const clipped = clip(`${"а".repeat(498)}😀😀`);
        expect(clipped).toBe(`${"а".repeat(498)}…`);
        expect(clipped.isWellFormed()).toBe(true);
    });
});
