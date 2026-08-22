import { describe, expect, it } from "vitest";
import { formatWorksUntil, lastSelectableDay } from "../last-working-day.js";

describe("lastSelectableDay", () => {
    it("stops the calendar on the last working day itself", () => {
        // Людина доопрацьовує до 5 вересня — 5-те ще її день.
        expect(lastSelectableDay("2026-09-05", 2026, 8, 30)).toBe(5);
    });

    it("gives the whole month to someone without an end date", () => {
        expect(lastSelectableDay(null, 2026, 8, 30)).toBe(30);
    });

    it("ignores an end date that falls in a later month", () => {
        expect(lastSelectableDay("2026-12-31", 2026, 8, 30)).toBe(30);
    });

    it("leaves nothing selectable when the month starts after departure", () => {
        expect(lastSelectableDay("2026-08-31", 2026, 8, 30)).toBe(0);
    });

    it("does not shorten the month for an unparseable date", () => {
        // Мовчки прихований місяць — гірша помилка, ніж зайвий день.
        expect(lastSelectableDay("later", 2026, 8, 30)).toBe(30);
    });

    it("clamps an end date past the end of a shorter month", () => {
        expect(lastSelectableDay("2026-02-31", 2026, 1, 28)).toBe(28);
    });

    it("compares years, not just month numbers", () => {
        // Той самий номер місяця, але торік — календар має бути порожній.
        expect(lastSelectableDay("2025-09-30", 2026, 8, 30)).toBe(0);
    });
});

describe("formatWorksUntil", () => {
    it("reads as a date a person would say out loud", () => {
        expect(formatWorksUntil("2026-08-31")).toBe("31 серпня");
    });

    it("drops the leading zero on single-digit days", () => {
        expect(formatWorksUntil("2026-09-05")).toBe("5 вересня");
    });

    it("returns an unparseable value as-is rather than blank", () => {
        // Порожнє місце там, де людина чекає дату, гірше за технічний вигляд.
        expect(formatWorksUntil("later")).toBe("later");
    });

    it("gives nothing back for no date", () => {
        expect(formatWorksUntil(null)).toBe("");
    });

    it("rejects an out-of-range month instead of printing undefined", () => {
        expect(formatWorksUntil("2026-13-01")).toBe("2026-13-01");
    });
});
