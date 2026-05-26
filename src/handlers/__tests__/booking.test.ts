import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { buildInterviewSlotNeededPatch, buildMentorReschedulePatch } from "../booking.js";

describe("buildMentorReschedulePatch", () => {
    it("returns accepted training-state patch for discovery reschedule", () => {
        const patch = buildMentorReschedulePatch(CandidateStatus.DISCOVERY_SCHEDULED);

        expect(patch).toMatchObject({
            status: CandidateStatus.ACCEPTED,
            currentStep: FunnelStep.TRAINING,
            isWaitlisted: false,
            notificationSent: false,
            trainingMeetLink: null,
        });
        expect(patch).not.toHaveProperty("discoverySlot");
        expect(patch).not.toHaveProperty("trainingSlot");
    });

    it("returns mentor waitlist patch for training reschedule", () => {
        const patch = buildMentorReschedulePatch(CandidateStatus.TRAINING_SCHEDULED);

        expect(patch).toMatchObject({
            status: CandidateStatus.WAITLIST_MENTOR,
            currentStep: FunnelStep.TRAINING,
            isWaitlisted: true,
            notificationSent: false,
            trainingMeetLink: null,
        });
        expect(patch).not.toHaveProperty("discoverySlot");
        expect(patch).not.toHaveProperty("trainingSlot");
    });
});

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
