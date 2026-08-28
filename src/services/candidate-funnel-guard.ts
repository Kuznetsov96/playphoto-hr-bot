import { CandidateStatus, FunnelStep, Prisma } from "@prisma/client";

export type CandidateFunnelSnapshot = {
    id: string;
    fullName: string | null;
    status: CandidateStatus;
    currentStep: FunnelStep;
    hrDecision: string | null;
    isWaitlisted: boolean;
    notificationSent: boolean;
    materialsSent: boolean;
    interviewCompletedAt: Date | null;
    interviewSlotId: string | null;
    discoverySlotId: string | null;
    trainingSlotId: string | null;
};

export type CandidateFunnelContext = {
    oldState: CandidateFunnelSnapshot;
    nextState: CandidateFunnelSnapshot;
    changedFields: string[];
};

export class InvalidCandidateTransitionError extends Error {
    reasonCode: string;
    context: CandidateFunnelContext;

    constructor(reasonCode: string, message: string, context: CandidateFunnelContext) {
        super(message);
        this.name = "InvalidCandidateTransitionError";
        this.reasonCode = reasonCode;
        this.context = context;
    }
}

type CandidateScalarPatch = Prisma.CandidateUpdateInput | Prisma.CandidateUpdateManyMutationInput;

const INTERVIEW_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
]);

const TRAINING_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.ACCEPTED,
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
]);

const FIRST_SHIFT_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
]);

function readScalarValue<T>(value: T | { set?: T } | undefined): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "object" && value !== null && "set" in value) {
        return (value as { set?: T }).set;
    }
    return value as T;
}

function hasRelationConnect(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && "connect" in (value as Record<string, unknown>));
}

function hasRelationDisconnect(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.disconnect === true || typeof record.disconnect === "object";
}

function isLegacyMentorWaitlist(state: CandidateFunnelSnapshot): boolean {
    return state.status === CandidateStatus.WAITLIST && state.currentStep === FunnelStep.TRAINING;
}

function isMentorTrackState(state: CandidateFunnelSnapshot): boolean {
    return ([
        CandidateStatus.MENTOR_MANUAL,
        CandidateStatus.DISCOVERY_SCHEDULED,
        CandidateStatus.DISCOVERY_COMPLETED,
        CandidateStatus.TRAINING_SCHEDULED,
        CandidateStatus.TRAINING_COMPLETED,
        CandidateStatus.NDA,
        CandidateStatus.KNOWLEDGE_TEST,
        ...Array.from(FIRST_SHIFT_TRACK_STATUSES),
    ] as CandidateStatus[]).includes(state.status) ||
        Boolean(state.discoverySlotId) ||
        Boolean(state.trainingSlotId);
}

function isMentorEligible(state: CandidateFunnelSnapshot): boolean {
    return Boolean(state.interviewCompletedAt) ||
        state.hrDecision === "ACCEPTED" ||
        Boolean(state.discoverySlotId) ||
        Boolean(state.trainingSlotId) ||
        ([
            CandidateStatus.MENTOR_MANUAL,
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
        ] as CandidateStatus[]).includes(state.status) ||
        (
            state.currentStep === FunnelStep.TRAINING &&
            ([
                CandidateStatus.ACCEPTED,
                CandidateStatus.WAITLIST_MENTOR,
                CandidateStatus.WAITLIST,
            ] as CandidateStatus[]).includes(state.status)
        ) ||
        isLegacyMentorWaitlist(state);
}

function isRecoverableUnderageRejection(state: CandidateFunnelSnapshot): boolean {
    return state.status === CandidateStatus.REJECTED && state.hrDecision === "REJECTED_SYSTEM_UNDERAGE";
}

function allowsTransition(oldState: CandidateFunnelSnapshot, nextStatus: CandidateStatus): boolean {
    if (oldState.status === nextStatus) return true;

    switch (nextStatus) {
        case CandidateStatus.SCREENING:
            return ([
                CandidateStatus.SCREENING,
                CandidateStatus.WAITLIST_HR,
                CandidateStatus.WAITLIST,
                CandidateStatus.MANUAL_REVIEW,
            ] as CandidateStatus[]).includes(oldState.status) || isRecoverableUnderageRejection(oldState);
        case CandidateStatus.WAITLIST_HR:
            return ([
                CandidateStatus.SCREENING,
                CandidateStatus.WAITLIST_HR,
                CandidateStatus.WAITLIST,
                CandidateStatus.INTERVIEW_SCHEDULED,
                CandidateStatus.INTERVIEW_COMPLETED,
            ] as CandidateStatus[]).includes(oldState.status) || isRecoverableUnderageRejection(oldState);
        case CandidateStatus.MANUAL_REVIEW:
            return ([
                CandidateStatus.SCREENING,
                CandidateStatus.MANUAL_REVIEW,
                CandidateStatus.WAITLIST_HR,
                CandidateStatus.WAITLIST,
            ] as CandidateStatus[]).includes(oldState.status) || isRecoverableUnderageRejection(oldState);
        case CandidateStatus.INTERVIEW_SCHEDULED:
            return ([
                CandidateStatus.SCREENING,
                CandidateStatus.WAITLIST_HR,
                CandidateStatus.WAITLIST,
                CandidateStatus.INTERVIEW_SCHEDULED,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.INTERVIEW_COMPLETED:
        case CandidateStatus.DECISION_PENDING:
            return ([
                CandidateStatus.INTERVIEW_SCHEDULED,
                CandidateStatus.INTERVIEW_COMPLETED,
                CandidateStatus.DECISION_PENDING,
            ] as CandidateStatus[]).includes(oldState.status) ||
                (
                    oldState.status === CandidateStatus.SCREENING &&
                    oldState.currentStep === FunnelStep.INTERVIEW &&
                    Boolean(oldState.interviewSlotId)
                );
        case CandidateStatus.ACCEPTED:
            return ([
                CandidateStatus.INTERVIEW_COMPLETED,
                CandidateStatus.DECISION_PENDING,
                CandidateStatus.ACCEPTED,
                CandidateStatus.WAITLIST_MENTOR,
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.DISCOVERY_COMPLETED,
            ] as CandidateStatus[]).includes(oldState.status) || isLegacyMentorWaitlist(oldState);
        case CandidateStatus.MENTOR_MANUAL:
            return ([
                CandidateStatus.INTERVIEW_COMPLETED,
                CandidateStatus.DECISION_PENDING,
                CandidateStatus.ACCEPTED,
                CandidateStatus.MENTOR_MANUAL,
            ] as CandidateStatus[]).includes(oldState.status) || isLegacyMentorWaitlist(oldState);
        case CandidateStatus.WAITLIST_MENTOR:
            return ([
                CandidateStatus.ACCEPTED,
                CandidateStatus.WAITLIST_MENTOR,
                CandidateStatus.DISCOVERY_COMPLETED,
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.TRAINING_SCHEDULED,
            ] as CandidateStatus[]).includes(oldState.status) || isLegacyMentorWaitlist(oldState);
        case CandidateStatus.DISCOVERY_SCHEDULED:
            return ([
                CandidateStatus.ACCEPTED,
                CandidateStatus.WAITLIST_MENTOR,
                CandidateStatus.DISCOVERY_SCHEDULED,
            ] as CandidateStatus[]).includes(oldState.status) || isLegacyMentorWaitlist(oldState);
        case CandidateStatus.DISCOVERY_COMPLETED:
            return ([
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.DISCOVERY_COMPLETED,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.TRAINING_SCHEDULED:
            return ([
                CandidateStatus.DISCOVERY_COMPLETED,
                CandidateStatus.TRAINING_SCHEDULED,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.TRAINING_COMPLETED:
            return ([
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.TRAINING_COMPLETED,
                // Ручной owner-контур из вебаппа (MARK_TRAINING_PASSED):
                // владелец ведёт кандидатку лично и отмечает пройденное
                // навчання со ЛЮБОГО статуса стадии TRAINING зеркала —
                // бот двигает воронку немо, без сообщений и уведомлений.
                CandidateStatus.ACCEPTED,
                CandidateStatus.MENTOR_MANUAL,
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.DISCOVERY_COMPLETED,
                CandidateStatus.NDA,
                CandidateStatus.KNOWLEDGE_TEST,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.NDA:
            return ([
                CandidateStatus.MENTOR_MANUAL,
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.TRAINING_COMPLETED,
                CandidateStatus.NDA,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.KNOWLEDGE_TEST:
            return ([
                CandidateStatus.TRAINING_COMPLETED,
                CandidateStatus.NDA,
                CandidateStatus.KNOWLEDGE_TEST,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.STAGING_SETUP:
            return ([
                CandidateStatus.KNOWLEDGE_TEST,
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.OFFLINE_STAGING,
                // Ручной owner-контур из вебаппа (START_STAGING): целевой
                // конвейер идёт TRAINING_COMPLETED → STAGING_SETUP без NDA и
                // KNOWLEDGE_TEST (решение владельца от 27.08.2026).
                CandidateStatus.TRAINING_COMPLETED,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.STAGING_ACTIVE:
            return ([
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.OFFLINE_STAGING,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.OFFLINE_STAGING:
            return ([
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.OFFLINE_STAGING,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.READY_FOR_HIRE:
            return ([
                CandidateStatus.NDA,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.OFFLINE_STAGING,
                CandidateStatus.READY_FOR_HIRE,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.AWAITING_FIRST_SHIFT:
            return ([
                CandidateStatus.READY_FOR_HIRE,
                CandidateStatus.AWAITING_FIRST_SHIFT,
            ] as CandidateStatus[]).includes(oldState.status);
        case CandidateStatus.HIRED:
            return ([
                CandidateStatus.READY_FOR_HIRE,
                CandidateStatus.AWAITING_FIRST_SHIFT,
                CandidateStatus.HIRED,
            ] as CandidateStatus[]).includes(oldState.status) || isMentorTrackState(oldState);
        case CandidateStatus.REJECTED:
        case CandidateStatus.BLOCKER:
        case CandidateStatus.WAITLIST:
            return true;
        default:
            return true;
    }
}

function requiredStepForStatus(status: CandidateStatus): FunnelStep | null {
    if (INTERVIEW_TRACK_STATUSES.has(status)) return FunnelStep.INTERVIEW;
    if (TRAINING_TRACK_STATUSES.has(status)) return FunnelStep.TRAINING;
    if (FIRST_SHIFT_TRACK_STATUSES.has(status)) return FunnelStep.FIRST_SHIFT;
    return null;
}

export function normalizeCandidateFunnelPatch(
    oldState: CandidateFunnelSnapshot,
    data: CandidateScalarPatch
): CandidateScalarPatch {
    const normalized = { ...data } as CandidateScalarPatch;
    const nextStatus = readScalarValue<CandidateStatus>((data as { status?: CandidateStatus | { set?: CandidateStatus } }).status);

    if (nextStatus !== undefined) {
        const requiredStep = requiredStepForStatus(nextStatus);
        if (requiredStep && (normalized as { currentStep?: unknown }).currentStep === undefined) {
            (normalized as { currentStep?: FunnelStep }).currentStep = requiredStep;
        }

        if (nextStatus === CandidateStatus.WAITLIST_MENTOR && (normalized as { isWaitlisted?: unknown }).isWaitlisted === undefined) {
            (normalized as { isWaitlisted?: boolean }).isWaitlisted = true;
        }

        if (nextStatus === CandidateStatus.ACCEPTED && (normalized as { isWaitlisted?: unknown }).isWaitlisted === undefined && oldState.isWaitlisted) {
            (normalized as { isWaitlisted?: boolean }).isWaitlisted = false;
        }
    }

    return normalized;
}

export function buildNextCandidateFunnelState(
    oldState: CandidateFunnelSnapshot,
    data: CandidateScalarPatch
): CandidateFunnelContext {
    const status = readScalarValue<CandidateStatus>((data as { status?: CandidateStatus | { set?: CandidateStatus } }).status) ?? oldState.status;
    const currentStep = readScalarValue<FunnelStep>((data as { currentStep?: FunnelStep | { set?: FunnelStep } }).currentStep) ?? oldState.currentStep;
    const hrDecision = readScalarValue<string | null>((data as { hrDecision?: string | null | { set?: string | null } }).hrDecision) ?? oldState.hrDecision;
    const isWaitlisted = readScalarValue<boolean>((data as { isWaitlisted?: boolean | { set?: boolean } }).isWaitlisted) ?? oldState.isWaitlisted;
    const notificationSent = readScalarValue<boolean>((data as { notificationSent?: boolean | { set?: boolean } }).notificationSent) ?? oldState.notificationSent;
    const materialsSent = readScalarValue<boolean>((data as { materialsSent?: boolean | { set?: boolean } }).materialsSent) ?? oldState.materialsSent;
    const interviewCompletedAt = readScalarValue<Date | null>((data as { interviewCompletedAt?: Date | null | { set?: Date | null } }).interviewCompletedAt) ?? oldState.interviewCompletedAt;

    const interviewSlot = (data as { interviewSlot?: unknown }).interviewSlot;
    const discoverySlot = (data as { discoverySlot?: unknown }).discoverySlot;
    const trainingSlot = (data as { trainingSlot?: unknown }).trainingSlot;

    const nextState: CandidateFunnelSnapshot = {
        ...oldState,
        status,
        currentStep,
        hrDecision,
        isWaitlisted,
        notificationSent,
        materialsSent,
        interviewCompletedAt,
        interviewSlotId: hasRelationConnect(interviewSlot) ? "__connected__" : hasRelationDisconnect(interviewSlot) ? null : oldState.interviewSlotId,
        discoverySlotId: hasRelationConnect(discoverySlot) ? "__connected__" : hasRelationDisconnect(discoverySlot) ? null : oldState.discoverySlotId,
        trainingSlotId: hasRelationConnect(trainingSlot) ? "__connected__" : hasRelationDisconnect(trainingSlot) ? null : oldState.trainingSlotId,
    };

    const changedFields = [
        oldState.status !== nextState.status ? "status" : null,
        oldState.currentStep !== nextState.currentStep ? "currentStep" : null,
        oldState.hrDecision !== nextState.hrDecision ? "hrDecision" : null,
        oldState.isWaitlisted !== nextState.isWaitlisted ? "isWaitlisted" : null,
        oldState.notificationSent !== nextState.notificationSent ? "notificationSent" : null,
        oldState.materialsSent !== nextState.materialsSent ? "materialsSent" : null,
        oldState.interviewCompletedAt?.toISOString() !== nextState.interviewCompletedAt?.toISOString() ? "interviewCompletedAt" : null,
        oldState.interviewSlotId !== nextState.interviewSlotId ? "interviewSlotId" : null,
        oldState.discoverySlotId !== nextState.discoverySlotId ? "discoverySlotId" : null,
        oldState.trainingSlotId !== nextState.trainingSlotId ? "trainingSlotId" : null,
    ].filter(Boolean) as string[];

    return { oldState, nextState, changedFields };
}

export function validateCandidateFunnelTransition(context: CandidateFunnelContext): void {
    const { oldState, nextState, changedFields } = context;

    if (changedFields.length === 0) return;

    const requiredStep = requiredStepForStatus(nextState.status);
    if (requiredStep && nextState.currentStep !== requiredStep) {
        throw new InvalidCandidateTransitionError(
            "STATUS_STEP_MISMATCH",
            `Status ${nextState.status} requires currentStep=${requiredStep}, got ${nextState.currentStep}`,
            context
        );
    }

    if (!allowsTransition(oldState, nextState.status)) {
        throw new InvalidCandidateTransitionError(
            "INVALID_STATUS_TRANSITION",
            `Transition ${oldState.status} -> ${nextState.status} is not allowed`,
            context
        );
    }

    const entersMentorFlow = !isMentorTrackState(oldState) && (
        isMentorTrackState(nextState) ||
        nextState.status === CandidateStatus.ACCEPTED ||
        nextState.materialsSent
    );

    if (entersMentorFlow && !isMentorEligible(oldState) && !isMentorEligible(nextState)) {
        throw new InvalidCandidateTransitionError(
            "MENTOR_FLOW_REQUIRES_APPROVAL",
            "Candidate cannot enter mentor flow without interview completion or explicit HR approval",
            context
        );
    }

    if (nextState.materialsSent && !isMentorEligible(nextState)) {
        throw new InvalidCandidateTransitionError(
            "MATERIALS_REQUIRE_MENTOR_ELIGIBILITY",
            "Candidate cannot receive mentor materials before mentor eligibility is established",
            context
        );
    }

    if (nextState.status === CandidateStatus.WAITLIST_HR && isMentorTrackState(oldState)) {
        throw new InvalidCandidateTransitionError(
            "HR_WAITLIST_FROM_MENTOR_FLOW",
            "Candidate already in mentor flow cannot be moved back to HR waitlist directly",
            context
        );
    }
}
