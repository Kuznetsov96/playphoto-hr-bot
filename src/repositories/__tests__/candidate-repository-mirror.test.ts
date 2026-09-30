import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 30.09.2026: бронь співбесіди, зроблена 29.09 о 20:12, дійшла до вебаппа лише
 * через 19 годин. Бронь — транзакція (разом з викликом Google Calendar), а
 * update(…, tx) ставив джоб дзеркала одразу; воркер забирав його до коміту,
 * читав ще старий SCREENING і пушив його. Після коміту пушу не було, тож
 * вебапп не бачив її серед співбесід, а рекрутерка надіслала їй запрошення.
 */
const enqueueCandidateMirrorPush = vi.fn().mockResolvedValue(undefined);

vi.mock("../../services/recruiting-mirror/push-service.js", () => ({ enqueueCandidateMirrorPush }));
vi.mock("../../db/core.js", () => ({ default: { candidate: {} } }));
vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logAuditEvent: vi.fn() }));
vi.mock("../../services/timeline-service.js", () => ({ timelineService: { trackStatusChange: vi.fn().mockResolvedValue(undefined) } }));

const snapshot = {
    id: "cand-1",
    fullName: "Марія",
    status: "SCREENING",
    currentStep: "INTERVIEW",
    hrDecision: null,
    isWaitlisted: false,
    notificationSent: true,
    materialsSent: false,
    interviewCompletedAt: null,
    interviewSlotId: null,
    discoverySlotId: null,
    trainingSlotId: null,
};

function makeClient() {
    return {
        candidate: {
            findUnique: vi.fn().mockResolvedValue(snapshot),
            update: vi.fn().mockResolvedValue({ ...snapshot, status: "INTERVIEW_SCHEDULED", user: null }),
        },
    };
}

describe("candidate mirror push timing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("запис у транзакції ставить пуш дзеркала з відстрочкою — воркер читає вже закомічений стан", async () => {
        const { candidateRepository } = await import("../candidate-repository.js");
        const tx = makeClient();

        await candidateRepository.update("cand-1", { status: "INTERVIEW_SCHEDULED" }, tx as any);

        await vi.waitFor(() => expect(enqueueCandidateMirrorPush).toHaveBeenCalled());
        const [id, options] = enqueueCandidateMirrorPush.mock.calls[0]!;
        expect(id).toBe("cand-1");
        // Інтерактивна транзакція Prisma живе щонайбільше 5 с (типовий timeout).
        expect(options?.delayMs).toBeGreaterThan(5000);
    });

    it("запис поза транзакцією пушиться одразу", async () => {
        const db = (await import("../../db/core.js")).default as any;
        Object.assign(db.candidate, makeClient().candidate);
        const { candidateRepository } = await import("../candidate-repository.js");

        await candidateRepository.update("cand-1", { status: "INTERVIEW_SCHEDULED" });

        await vi.waitFor(() => expect(enqueueCandidateMirrorPush).toHaveBeenCalled());
        const [, options] = enqueueCandidateMirrorPush.mock.calls[0]!;
        expect(options?.delayMs ?? 0).toBe(0);
    });
});
