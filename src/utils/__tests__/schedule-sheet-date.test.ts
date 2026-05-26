import { describe, expect, it } from "vitest";
import { parseScheduleHeaderDate, parseScheduleSheetYear } from "../schedule-sheet-date.js";

describe("schedule sheet date parsing", () => {
    it("uses the year from a monthly sheet name for text month headers", () => {
        const parsed = parseScheduleHeaderDate("1, січ", "Січень 2027");

        expect(parsed).toEqual(new Date(2027, 0, 1));
    });

    it("uses the year from a monthly sheet name for numeric date headers", () => {
        const parsed = parseScheduleHeaderDate("01.01", "Січень 2027");

        expect(parsed).toEqual(new Date(2027, 0, 1));
    });

    it("falls back to the provided year when the sheet name has no year", () => {
        expect(parseScheduleSheetYear("Актуальний розклад", 2026)).toBe(2026);
    });
});
