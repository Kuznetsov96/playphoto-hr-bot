import { describe, expect, it } from "vitest";
import { canNarrowByLocation, shouldSkipScopeStep } from "../task-bulk.js";

describe("shouldSkipScopeStep", () => {
    it("skips the scope question when there is nothing to narrow down", () => {
        expect(shouldSkipScopeStep(1)).toBe(true);
        expect(shouldSkipScopeStep(0)).toBe(true);
    });

    it("asks about scope once several locations are in play", () => {
        expect(shouldSkipScopeStep(2)).toBe(false);
        expect(shouldSkipScopeStep(9)).toBe(false);
    });
});

describe("canNarrowByLocation", () => {
    it("cannot narrow further with zero or one location in play", () => {
        expect(canNarrowByLocation(0)).toBe(false);
        expect(canNarrowByLocation(1)).toBe(false);
    });

    it("can narrow once several locations are in play", () => {
        expect(canNarrowByLocation(2)).toBe(true);
        expect(canNarrowByLocation(9)).toBe(true);
    });

    it("stays the mirror image of shouldSkipScopeStep for any location count", () => {
        for (const count of [0, 1, 2, 3, 10, 81]) {
            expect(canNarrowByLocation(count)).toBe(!shouldSkipScopeStep(count));
        }
    });
});
