import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B9, аудит 01.10.2026: причина втрати виводилась лише з патча. Worker і
 * ремонт ставлять тільки status, тож відмова HR після співбесіди писалась
 * як INTERVIEW_DROPOFF, неявка з ремонту — теж; самовідмова після броні
 * («відмовилась від вакансії») — так само. Анкета (upsert) не писала ні
 * причини, ні statusChangedAt.
 */
vi.mock("../../services/recruiting-mirror/push-service.js", () => ({ enqueueCandidateMirrorPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../db/core.js", () => ({ default: { candidate: {} } }));
vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logAuditEvent: vi.fn() }));
vi.mock("../../services/timeline-service.js", () => ({ timelineService: { trackStatusChange: vi.fn().mockResolvedValue(undefined) } }));

function snapshot(overrides: Record<string, unknown>) {
    return {
        id: "cand-1",
        fullName: "Марія",
        status: "INTERVIEW_COMPLETED",
        currentStep: "INTERVIEW",
        hrDecision: null,
        candidateDecision: null,
        isWaitlisted: false,
        notificationSent: false,
        materialsSent: false,
        interviewCompletedAt: new Date("2026-10-01T09:00:00Z"),
        interviewSlotId: "slot-1",
        discoverySlotId: null,
        trainingSlotId: null,
        ...overrides,
    };
}

async function writtenLoss(old: Record<string, unknown>, patch: Record<string, unknown>) {
    const tx = {
        candidate: {
            findUnique: vi.fn().mockResolvedValue(snapshot(old)),
            update: vi.fn().mockImplementation(async ({ data }) => ({ ...snapshot(old), ...data, user: null })),
        },
    };
    const { candidateRepository } = await import("../candidate-repository.js");
    await candidateRepository.update("cand-1", patch as any, tx as any);
    const { data } = tx.candidate.update.mock.calls[0]![0];
    return { lossStage: data.lossStage, lossReason: data.lossReason };
}

describe("причина втрати з підсумкового стану", () => {
    beforeEach(() => vi.clearAllMocks());

    it("доставлена відмова HR (worker): hrDecision лежить у кандидатки, не в патчі", async () => {
        const loss = await writtenLoss(
            { hrDecision: "REJECTED" },
            { status: "REJECTED", notificationSent: true },
        );
        expect(loss).toEqual({ lossStage: "INTERVIEW", lossReason: "INTERVIEW_REJECTED" });
    });

    it("ремонт INTERVIEW_COMPLETED + NOSHOW дає неявку, а не dropoff", async () => {
        const loss = await writtenLoss({ hrDecision: "NOSHOW" }, { status: "REJECTED" });
        expect(loss.lossReason).toBe("INTERVIEW_NO_SHOW");
    });

    it("відмова після співбесіди одним записом (rejectAfterInterview, PR #489)", async () => {
        const loss = await writtenLoss(
            {},
            { status: "REJECTED", hrDecision: "REJECTED", notificationSent: true },
        );
        expect(loss).toEqual({ lossStage: "INTERVIEW", lossReason: "INTERVIEW_REJECTED" });
    });

    it("«Завершити заявку» після броні (cwi) — самовідмова", async () => {
        const loss = await writtenLoss(
            { status: "INTERVIEW_SCHEDULED", interviewCompletedAt: null },
            { status: "REJECTED", candidateDecision: "Кандидатка відмовилась від вакансії", notificationSent: true },
        );
        expect(loss).toEqual({ lossStage: "INTERVIEW", lossReason: "CANDIDATE_DECLINED" });
    });

    it("відмова від запрошення (decline_invite) — самовідмова на етапі запису", async () => {
        const loss = await writtenLoss(
            { status: "SCREENING", interviewCompletedAt: null, interviewSlotId: null },
            { status: "REJECTED", candidateDecision: "Відмова кандидата (не актуально)", notificationSent: true },
        );
        expect(loss).toEqual({ lossStage: "INTERVIEW_BOOKING", lossReason: "CANDIDATE_DECLINED" });
    });

    it("без рішення HR після співбесіди лишається dropoff", async () => {
        const loss = await writtenLoss({}, { status: "REJECTED" });
        expect(loss.lossReason).toBe("INTERVIEW_DROPOFF");
    });
});

describe("upsert анкети", () => {
    beforeEach(() => vi.clearAllMocks());

    async function upsertWith(existing: Record<string, unknown> | null, update: Record<string, unknown>, create: Record<string, unknown> = {}) {
        const db = (await import("../../db/core.js")).default as any;
        db.candidate.findUnique = vi.fn().mockResolvedValue(existing);
        db.candidate.upsert = vi.fn().mockImplementation(async (args: any) => ({ id: "cand-1", ...args.update }));
        const { candidateRepository } = await import("../candidate-repository.js");
        await candidateRepository.upsert({ where: { userId: "user-1" }, create: { userId: "user-1", ...create } as any, update });
        return db.candidate.upsert.mock.calls[0]![0];
    }

    it("фінал анкети з відмовою пише причину й час зміни статусу", async () => {
        const args = await upsertWith(
            { status: "SCREENING", currentStep: "INITIAL_TEST", hrDecision: null, candidateDecision: null },
            { status: "REJECTED", hrDecision: "AGE_LIMIT" },
        );
        expect(args.update.statusChangedAt).toBeInstanceOf(Date);
        expect(args.update.lossReason).toBe("AGE_LIMIT");
        expect(args.update.lossStage).toBe("SCREENING");
    });

    it("нова анкета з відмовою (create) теж отримує причину", async () => {
        const args = await upsertWith(null, { status: "REJECTED" }, { status: "REJECTED", hrDecision: "REJECTED_SYSTEM_UNDERAGE" });
        expect(args.create.statusChangedAt).toBeInstanceOf(Date);
        expect(args.create.lossReason).toBe("UNDERAGE");
    });

    it("той самий статус — не зміна: причину й час не чіпає", async () => {
        const args = await upsertWith(
            { status: "REJECTED", currentStep: "INITIAL_TEST", hrDecision: "AGE_LIMIT", candidateDecision: null },
            { status: "REJECTED", city: "Lviv" },
        );
        expect(args.update).not.toHaveProperty("statusChangedAt");
        expect(args.update).not.toHaveProperty("lossReason");
    });

    it("крок анкети без статусу не читає базу", async () => {
        const args = await upsertWith(null, { city: "Lviv" });
        const db = (await import("../../db/core.js")).default as any;
        expect(db.candidate.findUnique).not.toHaveBeenCalled();
        expect(args.update).not.toHaveProperty("statusChangedAt");
    });
});
