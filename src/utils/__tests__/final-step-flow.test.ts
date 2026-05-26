import { describe, expect, it } from "vitest";
import { CandidateStatus } from "@prisma/client";
import { canConfirmNDA, getOnboardingResumeAction } from "../final-step-flow.js";

describe("final step flow guards", () => {
    it("allows NDA confirmation only for pending NDA candidates", () => {
        expect(canConfirmNDA({
            status: CandidateStatus.NDA,
            ndaConfirmedAt: null,
        })).toBe(true);

        expect(canConfirmNDA({
            status: CandidateStatus.NDA,
            ndaConfirmedAt: new Date("2026-05-06T10:00:00Z"),
        })).toBe(false);

        expect(canConfirmNDA({
            status: CandidateStatus.AWAITING_FIRST_SHIFT,
            ndaConfirmedAt: new Date("2026-05-06T10:00:00Z"),
        })).toBe(false);
    });

    it("finishes onboarding only once, then resumes preferences instead", () => {
        expect(getOnboardingResumeAction(
            CandidateStatus.READY_FOR_HIRE,
            "ONB_FINAL",
            "ONB_FINAL"
        )).toBe("finish_onboarding");

        expect(getOnboardingResumeAction(
            CandidateStatus.AWAITING_FIRST_SHIFT,
            "ONB_FINAL",
            "ONB_FINAL"
        )).toBe("prompt_preferences");

        expect(getOnboardingResumeAction(
            CandidateStatus.READY_FOR_HIRE,
            "ONB_PHONE",
            "ONB_FINAL"
        )).toBe("resume_form");
    });
});
