import { CandidateStatus, FunnelStep, Prisma } from "@prisma/client";
import { candidateRepository, type CandidateWithRelations } from "../repositories/candidate-repository.js";
import { logAuditEvent, logBusinessEvent } from "../core/log-events.js";
import {
    decideScreeningPlacement,
    getUnderageReactivationDecision,
    type UnderageReactivationCandidate,
    type UnderageReactivationMode,
} from "./underage-reactivation-service.js";

export type BlockerReturnMode = UnderageReactivationMode | "INTERVIEW_WAITLIST" | "REJECTED" | "ACCEPTED" | "UNDERAGE";

export type BlockerReturnCandidate = UnderageReactivationCandidate & { currentStep?: FunnelStep | null };

export type BlockerReturnDecision = {
    mode: BlockerReturnMode;
    patch: Prisma.CandidateUpdateInput;
};

const LOSS_RESET = {
    candidateDecision: null,
    lossStage: null,
    lossReason: null,
    lostAt: null,
} satisfies Prisma.CandidateUpdateInput;

/**
 * Куди повернути кандидатку з BLOCKER: на крок воронки, де вона була б,
 * якби повідомлення завжди доставлялись. interviewInvitedAt не ставимо —
 * запрошення не було.
 */
export function getBlockerReturnDecision(candidate: BlockerReturnCandidate): BlockerReturnDecision | null {
    if (candidate.status !== CandidateStatus.BLOCKER) return null;

    const hrDecision = candidate.hrDecision ?? null;

    if (hrDecision === "REJECTED_SYSTEM_UNDERAGE") {
        const underage = getUnderageReactivationDecision(candidate);
        if (underage) return { mode: "UNDERAGE", patch: underage.patch };
        return { mode: "REJECTED", patch: { status: CandidateStatus.REJECTED } };
    }

    if (hrDecision === "REJECTED" || hrDecision === "AGE_LIMIT" || hrDecision === "NOSHOW") {
        return { mode: "REJECTED", patch: { status: CandidateStatus.REJECTED } };
    }

    if (hrDecision === "ACCEPTED") {
        // MENTOR_MANUAL, а не ACCEPTED: з ACCEPTED воркер надсилає оффер удруге.
        return {
            mode: "ACCEPTED",
            patch: { status: CandidateStatus.MENTOR_MANUAL, hrDecision: "ACCEPTED", ...LOSS_RESET },
        };
    }

    if (hrDecision !== null) return null;

    if (candidate.currentStep === FunnelStep.TRAINING || candidate.currentStep === FunnelStep.FIRST_SHIFT) {
        return {
            mode: "ACCEPTED",
            patch: { status: CandidateStatus.MENTOR_MANUAL, hrDecision: "ACCEPTED", ...LOSS_RESET },
        };
    }

    if (candidate.currentStep === FunnelStep.INTERVIEW) {
        return {
            mode: "INTERVIEW_WAITLIST",
            patch: {
                status: CandidateStatus.WAITLIST_HR,
                currentStep: FunnelStep.INTERVIEW,
                isWaitlisted: true,
                ...LOSS_RESET,
            },
        };
    }

    return decideScreeningPlacement(candidate, { ...LOSS_RESET });
}

export async function returnBlockedCandidateIfNeeded(
    candidate: BlockerReturnCandidate,
    source: "start_command" | "free_text",
    tx?: Prisma.TransactionClient
): Promise<{ candidate: CandidateWithRelations; mode: BlockerReturnMode } | null> {
    const decision = getBlockerReturnDecision(candidate);
    if (!decision) return null;

    const updatedCandidate = await candidateRepository.update(candidate.id, decision.patch, tx);
    const telegramId = candidate.user?.telegramId ?? updatedCandidate.user?.telegramId;
    const event = {
        event: "candidate.blocker_returned",
        candidateId: candidate.id,
        telegramId,
        actorType: "system",
        actorRole: "system",
        stage: updatedCandidate.status,
        result: "success",
        module: "blocker-return-service",
        operation: "returnBlockedCandidateIfNeeded",
        safeContext: {
            source,
            mode: decision.mode,
            fromStatus: candidate.status,
            toStatus: updatedCandidate.status,
        },
    } as const;

    logBusinessEvent(event);
    logAuditEvent(event);

    return { candidate: updatedCandidate, mode: decision.mode };
}
