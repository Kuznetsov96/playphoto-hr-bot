import { CandidateStatus, FunnelStep, Prisma } from "@prisma/client";
import type { Location } from "@prisma/client";
import { candidateRepository, type CandidateWithRelations } from "../repositories/candidate-repository.js";
import { getBirthDateRejection, type CandidateAgeLocation } from "../utils/candidate-age.js";
import { logAuditEvent, logBusinessEvent } from "../core/log-events.js";

type ReactivationLocation = (NonNullable<CandidateAgeLocation> & Partial<Pick<Location, "neededCount" | "isHidden" | "isHiddenFromCandidates">>) | null | undefined;

export type UnderageReactivationCandidate = {
    id: string;
    fullName?: string | null;
    status: CandidateStatus;
    hrDecision?: string | null;
    birthDate?: Date | string | null;
    gender?: string | null;
    city?: string | null;
    locationId?: string | null;
    appearance?: string | null;
    source?: string | null;
    tattooPhotoId?: string | null;
    isOtherCity?: boolean | null;
    user?: { telegramId?: bigint | number | null } | null;
    location?: ReactivationLocation;
};

export type UnderageReactivationMode = "RESUME_SCREENING" | "READY_FOR_INTERVIEW" | "WAITLIST_HR" | "MANUAL_REVIEW";

export type UnderageReactivationDecision = {
    mode: UnderageReactivationMode;
    patch: Prisma.CandidateUpdateInput;
};

function hasCompletedScreening(candidate: UnderageReactivationCandidate): boolean {
    return Boolean(
        candidate.fullName &&
        candidate.gender &&
        candidate.birthDate &&
        candidate.city &&
        candidate.locationId &&
        candidate.appearance &&
        candidate.source
    );
}

function needsManualAppearanceReview(candidate: UnderageReactivationCandidate): boolean {
    if (candidate.tattooPhotoId) return true;
    if (!candidate.appearance) return false;
    return candidate.appearance.includes("[Фото]") || candidate.appearance !== "Без особливостей";
}

function hasOpenCandidateLocation(candidate: UnderageReactivationCandidate): boolean {
    const location = candidate.location;
    if (!location || candidate.isOtherCity) return false;
    if (location.isHidden || location.isHiddenFromCandidates) return false;
    return (location.neededCount ?? 0) > 0;
}

export function getUnderageReactivationDecision(candidate: UnderageReactivationCandidate): UnderageReactivationDecision | null {
    if (candidate.status !== CandidateStatus.REJECTED) return null;
    if (candidate.hrDecision !== "REJECTED_SYSTEM_UNDERAGE") return null;
    if (candidate.gender !== "female") return null;
    if (!candidate.birthDate) return null;
    if (getBirthDateRejection(candidate.birthDate, candidate.location) !== null) return null;

    const basePatch = {
        hrDecision: null,
        candidateDecision: null,
        lossStage: null,
        lossReason: null,
        lostAt: null,
        notificationSent: false,
        interviewWaitlistReason: null,
        interviewInvitedAt: null,
        hasUnreadMessage: false,
    } satisfies Prisma.CandidateUpdateInput;

    if (!hasCompletedScreening(candidate)) {
        return {
            mode: "RESUME_SCREENING",
            patch: {
                ...basePatch,
                status: CandidateStatus.SCREENING,
                isWaitlisted: false,
                currentStep: FunnelStep.INITIAL_TEST,
            },
        };
    }

    if (needsManualAppearanceReview(candidate)) {
        return {
            mode: "MANUAL_REVIEW",
            patch: {
                ...basePatch,
                status: CandidateStatus.MANUAL_REVIEW,
                isWaitlisted: false,
                currentStep: FunnelStep.INITIAL_TEST,
            },
        };
    }

    if (hasOpenCandidateLocation(candidate)) {
        return {
            mode: "READY_FOR_INTERVIEW",
            patch: {
                ...basePatch,
                status: CandidateStatus.SCREENING,
                isWaitlisted: false,
                currentStep: FunnelStep.INITIAL_TEST,
            },
        };
    }

    return {
        mode: "WAITLIST_HR",
        patch: {
            ...basePatch,
            status: CandidateStatus.WAITLIST_HR,
            isWaitlisted: true,
            currentStep: FunnelStep.INITIAL_TEST,
        },
    };
}

export async function reactivateUnderageCandidateIfEligible(
    candidate: UnderageReactivationCandidate,
    source: string,
    tx?: Prisma.TransactionClient
): Promise<{ candidate: CandidateWithRelations; mode: UnderageReactivationMode } | null> {
    const decision = getUnderageReactivationDecision(candidate);
    if (!decision) return null;

    const updatedCandidate = await candidateRepository.update(candidate.id, decision.patch, tx);
    const telegramId = candidate.user?.telegramId ?? updatedCandidate.user?.telegramId;

    logBusinessEvent({
        event: "candidate.underage_reactivated",
        candidateId: candidate.id,
        telegramId,
        actorType: "system",
        actorRole: "system",
        stage: updatedCandidate.status,
        result: "success",
        module: "underage-reactivation-service",
        operation: "reactivateUnderageCandidateIfEligible",
        safeContext: {
            source,
            mode: decision.mode,
            fromStatus: candidate.status,
            toStatus: updatedCandidate.status,
        },
    });

    logAuditEvent({
        event: "candidate.underage_reactivated",
        candidateId: candidate.id,
        telegramId,
        actorType: "system",
        actorRole: "system",
        stage: updatedCandidate.status,
        result: "success",
        module: "underage-reactivation-service",
        operation: "reactivateUnderageCandidateIfEligible",
        safeContext: {
            source,
            mode: decision.mode,
            fromStatus: candidate.status,
            toStatus: updatedCandidate.status,
        },
    });

    return { candidate: updatedCandidate, mode: decision.mode };
}
