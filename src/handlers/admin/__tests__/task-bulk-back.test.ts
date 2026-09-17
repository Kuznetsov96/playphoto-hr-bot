import { describe, expect, it } from "vitest";
import { previousStep, type BulkTaskStep } from "../task-bulk.js";

describe("previousStep", () => {
    it("has no previous step from SELECT_DATE — it is the entry screen", () => {
        expect(previousStep("SELECT_DATE", { locationCount: 5 })).toBeNull();
    });

    it("walks back one step at a time through the straight-line part of the wizard", () => {
        expect(previousStep("SELECT_CITIES", { locationCount: 5 })).toBe("SELECT_DATE");
        expect(previousStep("SELECT_SCOPE", { locationCount: 5 })).toBe("SELECT_CITIES");
        expect(previousStep("SELECT_LOCATIONS", { locationCount: 5 })).toBe("SELECT_SCOPE");
        expect(previousStep("SELECT_MODE", { locationCount: 5 })).toBe("SELECT_RECIPIENTS");
        expect(previousStep("AWAITING_TEXT", { locationCount: 5 })).toBe("SELECT_MODE");
        expect(previousStep("SELECT_DEADLINE", { locationCount: 5 })).toBe("AWAITING_TEXT");
        expect(previousStep("CONFIRM", { locationCount: 5 })).toBe("SELECT_DEADLINE");
    });

    // This is the regression that matters most: SELECT_SCOPE is auto-skipped
    // on the way forward whenever the chosen cities resolve to at most one
    // location (shouldSkipScopeStep). Back from SELECT_RECIPIENTS must mirror
    // that decision exactly, or the admin lands on a screen they never saw.
    it("back from recipients skips the scope step when there was only one location", () => {
        expect(previousStep("SELECT_RECIPIENTS", { locationCount: 1 })).toBe("SELECT_CITIES");
        expect(previousStep("SELECT_RECIPIENTS", { locationCount: 0 })).toBe("SELECT_CITIES");
    });

    it("back from recipients goes to the scope screen when it was actually shown", () => {
        expect(previousStep("SELECT_RECIPIENTS", { locationCount: 2 })).toBe("SELECT_SCOPE");
        expect(previousStep("SELECT_RECIPIENTS", { locationCount: 9 })).toBe("SELECT_SCOPE");
    });

    it("has no previous step for the transient SENDING state", () => {
        expect(previousStep("SENDING", { locationCount: 5 })).toBeNull();
    });

    it("covers every declared step without falling through to the default branch", () => {
        const steps: BulkTaskStep[] = [
            "SELECT_DATE", "SELECT_CITIES", "SELECT_SCOPE", "SELECT_LOCATIONS",
            "SELECT_RECIPIENTS", "SELECT_MODE", "AWAITING_TEXT", "SELECT_DEADLINE",
            "CONFIRM", "SENDING",
        ];
        for (const step of steps) {
            // Just exercising every branch; SELECT_DATE/SENDING legitimately return null.
            expect(() => previousStep(step, { locationCount: 3 })).not.toThrow();
        }
    });
});
