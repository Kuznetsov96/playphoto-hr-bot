import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import {
    buildNextCandidateFunnelState,
    normalizeCandidateFunnelPatch,
    validateCandidateFunnelTransition,
    type CandidateFunnelSnapshot,
} from "../candidate-funnel-guard.js";

/**
 * Ручной owner-контур из вебаппа (полный цикл найма): владелец общается с
 * кандидаткой лично со своего аккаунта, а команды MARK_TRAINING_PASSED /
 * START_STAGING двигают воронку бота НЕМО. Для этого гард обязан пропускать
 * прыжок в TRAINING_COMPLETED из любого статуса стадии TRAINING вебаппа и
 * шаг TRAINING_COMPLETED → STAGING_SETUP (целевой конвейер без NDA и
 * KNOWLEDGE_TEST — решение владельца от 27.08.2026).
 */

function stepFor(status: CandidateStatus): FunnelStep {
    if (([
        CandidateStatus.STAGING_SETUP,
        CandidateStatus.STAGING_ACTIVE,
        CandidateStatus.OFFLINE_STAGING,
        CandidateStatus.READY_FOR_HIRE,
        CandidateStatus.AWAITING_FIRST_SHIFT,
        CandidateStatus.HIRED,
    ] as CandidateStatus[]).includes(status)) return FunnelStep.FIRST_SHIFT;
    if (([
        CandidateStatus.SCREENING,
        CandidateStatus.WAITLIST_HR,
        CandidateStatus.MANUAL_REVIEW,
        CandidateStatus.INTERVIEW_SCHEDULED,
        CandidateStatus.INTERVIEW_COMPLETED,
        CandidateStatus.DECISION_PENDING,
    ] as CandidateStatus[]).includes(status)) return FunnelStep.INTERVIEW;
    return FunnelStep.TRAINING;
}

function snapshot(status: CandidateStatus, overrides: Partial<CandidateFunnelSnapshot> = {}): CandidateFunnelSnapshot {
    return {
        id: "cand-1",
        fullName: "Тестова Кандидатка",
        status,
        currentStep: stepFor(status),
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

/** Повторяет то, что делает candidateRepository.update: normalize → build → validate. */
function applyStatus(oldState: CandidateFunnelSnapshot, status: CandidateStatus) {
    const data = normalizeCandidateFunnelPatch(oldState, { status });
    const context = buildNextCandidateFunnelState(oldState, data);
    validateCandidateFunnelTransition(context);
    return context.nextState;
}

describe("candidate funnel guard: owner-контур из вебаппа", () => {
    const trainingStageStatuses = [
        CandidateStatus.ACCEPTED,
        CandidateStatus.MENTOR_MANUAL,
        CandidateStatus.DISCOVERY_SCHEDULED,
        CandidateStatus.DISCOVERY_COMPLETED,
        CandidateStatus.NDA,
        CandidateStatus.KNOWLEDGE_TEST,
    ];

    it.each(trainingStageStatuses.map(s => [s]))(
        "пропускает %s → TRAINING_COMPLETED (MARK_TRAINING_PASSED со стадии TRAINING)",
        (from) => {
            const next = applyStatus(snapshot(from), CandidateStatus.TRAINING_COMPLETED);
            expect(next.status).toBe(CandidateStatus.TRAINING_COMPLETED);
            expect(next.currentStep).toBe(FunnelStep.TRAINING);
        },
    );

    it("пропускает TRAINING_COMPLETED → STAGING_SETUP (START_STAGING без NDA/KNOWLEDGE_TEST)", () => {
        const next = applyStatus(snapshot(CandidateStatus.TRAINING_COMPLETED), CandidateStatus.STAGING_SETUP);
        expect(next.status).toBe(CandidateStatus.STAGING_SETUP);
        expect(next.currentStep).toBe(FunnelStep.FIRST_SHIFT);
    });

    it("по-прежнему пропускает STAGING_SETUP → STAGING_ACTIVE и STAGING_ACTIVE → READY_FOR_HIRE", () => {
        const active = applyStatus(snapshot(CandidateStatus.STAGING_SETUP), CandidateStatus.STAGING_ACTIVE);
        expect(active.status).toBe(CandidateStatus.STAGING_ACTIVE);
        const ready = applyStatus(active, CandidateStatus.READY_FOR_HIRE);
        expect(ready.status).toBe(CandidateStatus.READY_FOR_HIRE);
    });

    it("по-прежнему отвергает SCREENING → TRAINING_COMPLETED — owner-контур не открывает дыру из ранней воронки", () => {
        expect(() => applyStatus(snapshot(CandidateStatus.SCREENING), CandidateStatus.TRAINING_COMPLETED))
            .toThrowError(expect.objectContaining({ reasonCode: expect.any(String) }));
    });

    it("по-прежнему отвергает SCREENING → STAGING_SETUP", () => {
        expect(() => applyStatus(snapshot(CandidateStatus.SCREENING), CandidateStatus.STAGING_SETUP))
            .toThrowError(expect.objectContaining({ reasonCode: "INVALID_STATUS_TRANSITION" }));
    });
});
