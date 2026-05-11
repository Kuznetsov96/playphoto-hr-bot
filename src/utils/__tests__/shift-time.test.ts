import { describe, expect, it } from "vitest";
import { getShiftTimeFromLocationSchedule } from "../shift-time.js";

describe("getShiftTimeFromLocationSchedule", () => {
    it("returns all-days schedule for weekdays and weekends", () => {
        const schedule = "Пн-Нд — 12:00-21:00";

        expect(getShiftTimeFromLocationSchedule(schedule, new Date("2026-05-18T00:00:00.000Z"))).toBe("12:00-21:00");
        expect(getShiftTimeFromLocationSchedule(schedule, new Date("2026-05-24T00:00:00.000Z"))).toBe("12:00-21:00");
    });

    it("returns weekday and weekend ranges from split schedule", () => {
        const schedule = "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00";

        expect(getShiftTimeFromLocationSchedule(schedule, new Date("2026-05-18T00:00:00.000Z"))).toBe("14:00-21:00");
        expect(getShiftTimeFromLocationSchedule(schedule, new Date("2026-05-24T00:00:00.000Z"))).toBe("12:00-21:00");
    });
});
