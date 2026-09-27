import { describe, expect, it } from "vitest";
import { monthNameFromCanonical, nextCanonicalMonth } from "../preference-month.js";

describe("monthNameFromCanonical", () => {
    it("names the month of a YYYY-MM", () => {
        expect(monthNameFromCanonical("2026-11")).toBe("листопад");
        expect(monthNameFromCanonical("2027-01")).toBe("січень");
    });

    it("refuses to guess an unreadable month", () => {
        expect(monthNameFromCanonical("2026-13")).toBeNull();
        expect(monthNameFromCanonical("листопад")).toBeNull();
        expect(monthNameFromCanonical(null)).toBeNull();
    });
});

describe("nextCanonicalMonth", () => {
    it("targets next month in Kyiv", () => {
        expect(nextCanonicalMonth(new Date("2026-10-23T07:00:00.000Z"))).toBe("2026-11");
    });

    it("rolls December over to January", () => {
        expect(nextCanonicalMonth(new Date("2026-12-23T08:00:00.000Z"))).toBe("2027-01");
    });

    it("reads the month in Kyiv, not in UTC", () => {
        // 00:30 1 листопада по Киеву — в UTC ещё 31 жовтня.
        expect(nextCanonicalMonth(new Date("2026-10-31T22:30:00.000Z"))).toBe("2026-12");
    });
});
