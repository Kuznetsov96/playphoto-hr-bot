import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import {
    buildNextCandidateFunnelState,
    InvalidCandidateTransitionError,
    normalizeCandidateFunnelPatch,
    validateCandidateFunnelTransition,
    type CandidateFunnelSnapshot,
} from "../candidate-funnel-guard.js";

function makeCandidate(overrides: Partial<CandidateFunnelSnapshot> = {}): CandidateFunnelSnapshot {
    return {
        id: "cand-1",
        fullName: "Test Candidate",
        status: CandidateStatus.SCREENING,
        currentStep: FunnelStep.INITIAL_TEST,
        hrDecision: null,
        isWaitlisted: false,
        notificationSent: false,
        materialsSent: false,
        interviewCompletedAt: null,
        interviewSlotId: null,
        discoverySlotId: null,
        trainingSlotId: null,
        ...overrides,
    };
}

describe("candidate funnel guard", () => {
    it("normalizes accepted candidates into the training step", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.INTERVIEW_COMPLETED,
            currentStep: FunnelStep.INTERVIEW,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });

        const normalized = normalizeCandidateFunnelPatch(oldState, {
            status: CandidateStatus.ACCEPTED,
        });

        expect((normalized as any).currentStep).toBe(FunnelStep.TRAINING);
    });

    it("allows moving from screening to interview scheduled", () => {
        const oldState = makeCandidate();
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.INTERVIEW_SCHEDULED,
            currentStep: FunnelStep.INTERVIEW,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("blocks direct accepted transition from hr waitlist without approval", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.WAITLIST_HR,
            isWaitlisted: true,
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.ACCEPTED,
            currentStep: FunnelStep.TRAINING,
            materialsSent: true,
        });

        expect(() => validateCandidateFunnelTransition(context)).toThrow(InvalidCandidateTransitionError);
    });

    it("allows accepted transition after interview completion", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.INTERVIEW_COMPLETED,
            currentStep: FunnelStep.INTERVIEW,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.ACCEPTED,
            currentStep: FunnelStep.TRAINING,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("blocks discovery scheduling without mentor eligibility", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.ACCEPTED,
            currentStep: FunnelStep.INITIAL_TEST,
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.DISCOVERY_SCHEDULED,
            currentStep: FunnelStep.TRAINING,
        });

        expect(() => validateCandidateFunnelTransition(context)).toThrow(InvalidCandidateTransitionError);
    });

    it("allows discovery scheduling after accepted mentor handoff", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.ACCEPTED,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
            materialsSent: true,
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.DISCOVERY_SCHEDULED,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("blocks mentor materials before approval or interview completion", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.SCREENING,
        });
        const context = buildNextCandidateFunnelState(oldState, {
            materialsSent: true,
        });

        expect(() => validateCandidateFunnelTransition(context)).toThrow(InvalidCandidateTransitionError);
    });

    it("allows final-stage progression from knowledge test to staging setup", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.KNOWLEDGE_TEST,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.STAGING_SETUP,
            currentStep: FunnelStep.FIRST_SHIFT,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("blocks status/currentStep mismatch for final stages", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.KNOWLEDGE_TEST,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.STAGING_SETUP,
            currentStep: FunnelStep.TRAINING,
        });

        expect(() => validateCandidateFunnelTransition(context)).toThrow(InvalidCandidateTransitionError);
    });

    it("allows nda to knowledge test progression", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.NDA,
            currentStep: FunnelStep.TRAINING,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.KNOWLEDGE_TEST,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("allows staging active to ready for hire progression", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.STAGING_ACTIVE,
            currentStep: FunnelStep.FIRST_SHIFT,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.READY_FOR_HIRE,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });

    it("allows ready for hire to awaiting first shift progression", () => {
        const oldState = makeCandidate({
            status: CandidateStatus.READY_FOR_HIRE,
            currentStep: FunnelStep.FIRST_SHIFT,
            hrDecision: "ACCEPTED",
            interviewCompletedAt: new Date("2026-04-01T10:00:00Z"),
        });
        const context = buildNextCandidateFunnelState(oldState, {
            status: CandidateStatus.AWAITING_FIRST_SHIFT,
        });

        expect(() => validateCandidateFunnelTransition(context)).not.toThrow();
    });
});
