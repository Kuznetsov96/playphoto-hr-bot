import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { buildInterviewSlotNeededPatch } from "../booking.js";

describe("buildInterviewSlotNeededPatch", () => {
    it("keeps candidates in screening instead of location waitlist", () => {
        const patch = buildInterviewSlotNeededPatch("NO_DATE_FITS");

        expect(patch).toMatchObject({
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INTERVIEW,
            isWaitlisted: false,
            notificationSent: false,
            interviewWaitlistReason: "NO_DATE_FITS",
        });
    });
});
