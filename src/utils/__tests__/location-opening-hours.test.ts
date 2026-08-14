import { describe, expect, it } from "vitest";
import { getShiftTimeFromOpeningHours, isoDayOfWeekInKyiv } from "../location-opening-hours.js";

const VOLKLAND_2 = [
    { dayOfWeek: 1, opens: "14:00", closes: "21:00" },
    { dayOfWeek: 2, opens: "14:00", closes: "21:00" },
    { dayOfWeek: 3, opens: "14:00", closes: "21:00" },
    { dayOfWeek: 4, opens: "14:00", closes: "21:00" },
    { dayOfWeek: 5, opens: "14:00", closes: "21:00" },
    { dayOfWeek: 6, opens: "12:00", closes: "21:00" },
    { dayOfWeek: 7, opens: "12:00", closes: "21:00" },
];

describe("isoDayOfWeekInKyiv", () => {
    it("maps dates to ISO weekdays", () => {
        // 2026-08-19 is a Wednesday, 2026-08-15 a Saturday, 2026-08-16 a Sunday.
        expect(isoDayOfWeekInKyiv(new Date("2026-08-19T00:00:00.000Z"))).toBe(3);
        expect(isoDayOfWeekInKyiv(new Date("2026-08-15T00:00:00.000Z"))).toBe(6);
        expect(isoDayOfWeekInKyiv(new Date("2026-08-16T00:00:00.000Z"))).toBe(7);
    });

    it("reads the weekday in Kyiv, not UTC", () => {
        // 22:30 UTC on Saturday is already Sunday 01:30 in Kyiv (UTC+3 in summer).
        // Using UTC here would report Saturday and pick the wrong day's hours.
        expect(isoDayOfWeekInKyiv(new Date("2026-08-15T22:30:00.000Z"))).toBe(7);
    });
});

describe("getShiftTimeFromOpeningHours", () => {
    it("picks the hours recorded for that specific weekday", () => {
        expect(getShiftTimeFromOpeningHours(VOLKLAND_2, new Date("2026-08-19T00:00:00.000Z")))
            .toBe("14:00-21:00");
        expect(getShiftTimeFromOpeningHours(VOLKLAND_2, new Date("2026-08-15T00:00:00.000Z")))
            .toBe("12:00-21:00");
    });

    it("supports per-day hours that a weekday/weekend split cannot express", () => {
        // The text format could only say "Пн-Пт" and "Сб-Нд"; a Friday that differs from
        // the rest of the week was unrepresentable before.
        const perDay = [...VOLKLAND_2.filter((d) => d.dayOfWeek !== 5), { dayOfWeek: 5, opens: "16:00", closes: "23:00" }];
        expect(getShiftTimeFromOpeningHours(perDay, new Date("2026-08-21T00:00:00.000Z")))
            .toBe("16:00-23:00");
    });

    it("keeps overnight hours in their stored order", () => {
        // `closes` < `opens` means past midnight. It must render as-is, not be reordered.
        const overnight = [{ dayOfWeek: 3, opens: "22:00", closes: "06:00" }];
        expect(getShiftTimeFromOpeningHours(overnight, new Date("2026-08-19T00:00:00.000Z")))
            .toBe("22:00-06:00");
    });

    it("returns undefined when the location has no hours for that day", () => {
        expect(getShiftTimeFromOpeningHours([], new Date("2026-08-19T00:00:00.000Z"))).toBeUndefined();
        expect(getShiftTimeFromOpeningHours(undefined, new Date("2026-08-19T00:00:00.000Z"))).toBeUndefined();
        // Monday-only hours must not leak into a Wednesday.
        expect(getShiftTimeFromOpeningHours(
            [{ dayOfWeek: 1, opens: "14:00", closes: "21:00" }],
            new Date("2026-08-19T00:00:00.000Z"),
        )).toBeUndefined();
    });
});
