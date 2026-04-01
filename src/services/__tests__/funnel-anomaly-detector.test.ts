import { CandidateStatus, FunnelStep } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isImpossibleMentorState, type FunnelAnomalyCandidate } from "../funnel-anomaly-detector.js";

function makeCandidate(overrides: Partial<FunnelAnomalyCandidate> = {}): FunnelAnomalyCandidate {
    return {
        status: CandidateStatus.STAGING_SETUP,
        currentStep: FunnelStep.FIRST_SHIFT,
        interviewCompletedAt: null,
        hrDecision: null,
        materialsSent: false,
        discoverySlotId: null,
        trainingSlotId: null,
        discoveryCompletedAt: null,
        trainingCompletedAt: null,
        ndaSentAt: null,
        ndaConfirmedAt: null,
        quizScore: null,
        testPassed: null,
        firstShiftDate: null,
        firstShiftTime: null,
        ...overrides,
    };
}

describe("funnel anomaly detector", () => {
    it("does not flag candidates who have real mentor-track evidence", () => {
        const mayaLikeCandidate = makeCandidate({
            ndaSentAt: new Date("2026-04-01T09:18:38.678Z"),
            ndaConfirmedAt: new Date("2026-04-01T09:28:01.041Z"),
            quizScore: 42,
            testPassed: true,
            firstShiftDate: new Date("2026-04-05T09:00:00.000Z"),
            firstShiftTime: "15:00-17:00",
        });

        expect(isImpossibleMentorState(mayaLikeCandidate)).toBe(false);
    });

    it("flags final-stage candidates with no HR approval and no mentor evidence", () => {
        const impossibleCandidate = makeCandidate();

        expect(isImpossibleMentorState(impossibleCandidate)).toBe(true);
    });

    it("does not flag approved mentor-track candidates", () => {
        const approvedCandidate = makeCandidate({
            status: CandidateStatus.DISCOVERY_SCHEDULED,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
        });

        expect(isImpossibleMentorState(approvedCandidate)).toBe(false);
    });
});
