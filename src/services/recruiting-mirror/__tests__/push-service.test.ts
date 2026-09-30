import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * enqueueCandidateMirrorPush — единственная точка входа зеркала из
 * candidate-repository. Флаг выключен по умолчанию, поэтому выключенное
 * состояние обязано быть полным no-op: ни импорта очереди, ни джоба.
 */
const queueAdd = vi.fn().mockResolvedValue(undefined);

describe("enqueueCandidateMirrorPush", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.doMock("../../../core/queue.js", () => ({
            defaultQueue: { add: queueAdd },
        }));
    });

    it("flag OFF: does not enqueue anything", async () => {
        vi.doMock("../../../config.js", () => ({ AWS_RECRUITING_MIRROR_ENABLED: false }));

        const { enqueueCandidateMirrorPush } = await import("../push-service.js");
        await enqueueCandidateMirrorPush("cand-1");

        expect(queueAdd).not.toHaveBeenCalled();
    });

    it("flag ON: enqueues a recruiting-mirror-push job with retries and backoff", async () => {
        vi.doMock("../../../config.js", () => ({ AWS_RECRUITING_MIRROR_ENABLED: true }));

        const { enqueueCandidateMirrorPush } = await import("../push-service.js");
        await enqueueCandidateMirrorPush("cand-1");

        expect(queueAdd).toHaveBeenCalledWith(
            "recruiting-mirror-push",
            { candidateId: "cand-1" },
            expect.objectContaining({
                attempts: 5,
                backoff: expect.objectContaining({ type: "exponential" }),
            })
        );
    });
});

describe("enqueueCandidateMirrorPush delay", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.doMock("../../../core/queue.js", () => ({ defaultQueue: { add: queueAdd } }));
        vi.doMock("../../../config.js", () => ({ AWS_RECRUITING_MIRROR_ENABLED: true }));
    });

    it("відстрочка з транзакції доходить до BullMQ", async () => {
        const { enqueueCandidateMirrorPush } = await import("../push-service.js");
        await enqueueCandidateMirrorPush("cand-1", { delayMs: 15000 });

        expect(queueAdd).toHaveBeenCalledWith(
            "recruiting-mirror-push",
            { candidateId: "cand-1" },
            expect.objectContaining({ delay: 15000 }),
        );
    });
});

describe("processCandidateMirrorPush", () => {
    const pushRecruitingCandidate = vi.fn();
    const findUnique = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.doMock("../../../config.js", () => ({ AWS_RECRUITING_MIRROR_ENABLED: true }));
        vi.doMock("../../../core/queue.js", () => ({ defaultQueue: { add: queueAdd } }));
        // Воркер читает через prisma напрямую, а не через candidateRepository:
        // репозиторий сам ставит эти джобы, обратный импорт замкнул бы цикл.
        vi.doMock("../../../db/core.js", () => ({
            default: { candidate: { findUnique, updateMany } },
        }));
        vi.doMock("../../aws-business-client.js", () => ({
            awsBusinessClient: { pushRecruitingCandidate },
        }));
    });

    it("loads the candidate fresh, builds the snapshot and pushes it", async () => {
        findUnique.mockResolvedValue({
            id: "cand-1",
            fullName: "Олена Тест",
            phone: null,
            gender: "female",
            birthDate: null,
            city: "Київ",
            source: null,
            status: "SCREENING",
            hrDecision: null,
            lossStage: null,
            lossReason: null,
            statusChangedAt: null,
            pipelineTouchedAt: new Date("2026-08-21T09:30:00.000Z"),
            user: { telegramId: 1164289764n, username: null, createdAt: new Date("2026-08-01T08:00:00.000Z") },
            location: null,
            interviewSlot: null,
        });
        pushRecruitingCandidate.mockResolvedValue({ publicId: "pub-1", stage: "SCREENING" });

        const { processCandidateMirrorPush } = await import("../push-service.js");
        await processCandidateMirrorPush("cand-1");

        expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "cand-1" } }));
        expect(pushRecruitingCandidate).toHaveBeenCalledWith(
            expect.objectContaining({
                telegramId: "1164289764",
                botCandidateId: "cand-1",
                botStatus: "SCREENING",
            })
        );
        // Вебапп підтвердив саме цей стан — сверка більше його не пушить.
        const touched = new Date("2026-08-21T09:30:00.000Z");
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "cand-1", OR: [{ mirroredAt: null }, { mirroredAt: { lt: touched } }] },
            data: { mirroredAt: touched },
        });
    });

    it("succeeds silently when the candidate no longer exists — deleted candidates are not mirrored", async () => {
        findUnique.mockResolvedValue(null);

        const { processCandidateMirrorPush } = await import("../push-service.js");
        await expect(processCandidateMirrorPush("gone")).resolves.toBeUndefined();

        expect(pushRecruitingCandidate).not.toHaveBeenCalled();
    });

    it("rethrows a push failure so BullMQ retries the job", async () => {
        findUnique.mockResolvedValue({
            id: "cand-1",
            status: "SCREENING",
            pipelineTouchedAt: new Date(),
            user: { telegramId: 1n, username: null, createdAt: null },
            location: null,
            interviewSlot: null,
        });
        pushRecruitingCandidate.mockRejectedValue(new Error("HTTP 503"));

        const { processCandidateMirrorPush } = await import("../push-service.js");
        await expect(processCandidateMirrorPush("cand-1")).rejects.toThrow("HTTP 503");
        // Непідтверджене лишається непідтвердженим — сверка підбере.
        expect(updateMany).not.toHaveBeenCalled();
    });
});

/**
 * Сверка — страховка доставки. Будь-яка зміна через репозиторій пише
 * pipelineTouchedAt у тій самій транзакції, що й сама зміна; mirroredAt —
 * що вебапп підтвердив. Розрив означає, що вебапп бачить не те, і його
 * доганяють без ручного бекфілу (30.09.2026 бронь не доходила 19 годин).
 */
describe("runRecruitingMirrorSweep", () => {
    const pushRecruitingCandidate = vi.fn();
    const findUnique = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const queryRaw = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        vi.doMock("../../../config.js", () => ({ AWS_RECRUITING_MIRROR_ENABLED: true }));
        vi.doMock("../../../core/queue.js", () => ({ defaultQueue: { add: queueAdd } }));
        vi.doMock("../../../db/core.js", () => ({
            default: { candidate: { findUnique, updateMany }, $queryRaw: queryRaw },
        }));
        vi.doMock("../../aws-business-client.js", () => ({
            awsBusinessClient: { pushRecruitingCandidate },
        }));
    });

    it("пушить розійдені й не зупиняється на першій помилці", async () => {
        queryRaw.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
        findUnique.mockImplementation(async ({ where }: any) => ({
            id: where.id,
            status: "SCREENING",
            pipelineTouchedAt: new Date(),
            user: { telegramId: 1n, username: null, createdAt: null },
            location: null,
            interviewSlot: null,
        }));
        pushRecruitingCandidate
            .mockResolvedValueOnce({ publicId: "p-a", stage: "SCREENING" })
            .mockRejectedValueOnce(new Error("HTTP 503"))
            .mockResolvedValueOnce({ publicId: "p-c", stage: "SCREENING" });

        const { runRecruitingMirrorSweep } = await import("../push-service.js");
        const result = await runRecruitingMirrorSweep(100);

        expect(pushRecruitingCandidate).toHaveBeenCalledTimes(3);
        expect(result).toEqual({ selected: 3, pushed: 2, failed: 1 });
    });
});
