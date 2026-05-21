import { describe, expect, it } from "vitest";
import { FIRST_SHIFT_ONBOARDING_STEPS } from "../first-shift-onboarding-texts.js";

describe("FIRST_SHIFT_ONBOARDING_STEPS", () => {
    it("asks to set up flash before taking a test photo and importing it", () => {
        const flashIndex = FIRST_SHIFT_ONBOARDING_STEPS.findIndex(step => step.key === "flash_setup");
        const importIndex = FIRST_SHIFT_ONBOARDING_STEPS.findIndex(step => step.key === "camera_import_test");

        expect(flashIndex).toBeGreaterThan(-1);
        expect(importIndex).toBeGreaterThan(-1);
        expect(flashIndex).toBeLessThan(importIndex);
        expect(FIRST_SHIFT_ONBOARDING_STEPS[6]?.key).toBe("flash_setup");
        expect(FIRST_SHIFT_ONBOARDING_STEPS[7]?.key).toBe("camera_import_test");
    });
});
