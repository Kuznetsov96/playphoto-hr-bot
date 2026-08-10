import { describe, expect, it } from "vitest";
import { toCanonicalMonth, UKRAINIAN_MONTH_INDEX } from "../preference-month.js";

describe("toCanonicalMonth", () => {
    it("converts a Ukrainian month name and year into YYYY-MM", () => {
        expect(toCanonicalMonth("вересень", 2026)).toBe("2026-09");
        expect(toCanonicalMonth("січень", 2026)).toBe("2026-01");
        expect(toCanonicalMonth("грудень", 2026)).toBe("2026-12");
    });

    it("is case-insensitive, matching how the session stores the name", () => {
        expect(toCanonicalMonth("Вересень", 2026)).toBe("2026-09");
    });

    it("returns null for an unknown month instead of guessing", () => {
        expect(toCanonicalMonth("smarch", 2026)).toBeNull();
        expect(toCanonicalMonth(undefined, 2026)).toBeNull();
    });

    it("returns null without a year, so no request is sent for the wrong year", () => {
        expect(toCanonicalMonth("вересень", undefined)).toBeNull();
    });

    it("covers all twelve months", () => {
        expect(Object.keys(UKRAINIAN_MONTH_INDEX)).toHaveLength(12);
    });
});
