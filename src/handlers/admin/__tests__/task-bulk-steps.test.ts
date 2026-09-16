import { describe, expect, it } from "vitest";
import { shouldSkipScopeStep } from "../task-bulk.js";

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
