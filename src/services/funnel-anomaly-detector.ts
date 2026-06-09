import { CandidateStatus, FunnelStep } from "@prisma/client";

const MENTOR_OR_FINAL_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.ACCEPTED,
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
]);

export type FunnelAnomalyCandidate = {
    status: CandidateStatus;
    currentStep: FunnelStep;
    interviewCompletedAt: Date | null;
    hrDecision: string | null;
    materialsSent: boolean;
    discoverySlotId: string | null;
    trainingSlotId: string | null;
    discoveryCompletedAt: Date | null;
    trainingCompletedAt: Date | null;
    ndaSentAt: Date | null;
    ndaConfirmedAt: Date | null;
    quizScore: number | null;
    testPassed: boolean | null;
    firstShiftDate: Date | null;
    firstShiftTime: string | null;
};

export function hasMentorTrackEvidence(candidate: FunnelAnomalyCandidate): boolean {
    return Boolean(
        candidate.materialsSent ||
        candidate.discoverySlotId ||
        candidate.trainingSlotId ||
        candidate.discoveryCompletedAt ||
        candidate.trainingCompletedAt ||
        candidate.ndaSentAt ||
        candidate.ndaConfirmedAt ||
        candidate.quizScore !== null ||
        candidate.testPassed === true ||
        candidate.firstShiftDate ||
        candidate.firstShiftTime
    );
}

export function isImpossibleMentorState(candidate: FunnelAnomalyCandidate): boolean {
    const lacksHrApprovalEvidence = !candidate.interviewCompletedAt && candidate.hrDecision !== "ACCEPTED";
    const inMentorOrFinalState = MENTOR_OR_FINAL_STATUSES.has(candidate.status);

    if (!lacksHrApprovalEvidence || !inMentorOrFinalState) {
        return false;
    }

    return !hasMentorTrackEvidence(candidate);
}
