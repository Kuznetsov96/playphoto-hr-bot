import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Рассылки по пулу ожидания города (фаза 3b). Выборка получателей обязана
 * совпадать с оценкой вебаппа: он считает зеркальные строки со стадиями
 * SCREENING/WAITLIST, значит бот берёт ровно те статусы, которые в эти стадии
 * зеркалятся (включая MANUAL_REVIEW → SCREENING — см. stage-mapping вебаппа),
 * и тот же city, что уходит в снимке зеркала. Больше 500 получателей —
 * отказ BROADCAST_TOO_LARGE без единой отправки.
 */
const listPendingBroadcasts = vi.fn();
const ackDone = vi.fn();
const ackBroadcastFailed = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingRecruitingBroadcasts: listPendingBroadcasts,
        ackRecruitingBroadcastDone: ackDone,
        ackRecruitingBroadcastFailed: ackBroadcastFailed,
    },
}));

const findByStatusWithUser = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByStatusWithUser },
}));

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runPendingRecruitingBroadcasts } = await import("../recruiting-broadcast-delivery.js");

const makeApi = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }) });

const broadcast = (overrides: Partial<Record<string, unknown>> = {}) => ({
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    city: "Черкаси",
    body: "У нас відкрилися нові вікна для співбесід!",
    ...overrides,
});

const recipient = (telegramId: number) => ({
    id: `cand-${telegramId}`,
    user: { id: `user-${telegramId}`, telegramId: BigInt(telegramId) },
});

beforeEach(() => {
    vi.clearAllMocks();
    listPendingBroadcasts.mockResolvedValue({ items: [], stages: ["SCREENING", "WAITLIST"] });
    findByStatusWithUser.mockResolvedValue([]);
    ackDone.mockResolvedValue({ publicId: "x", status: "APPLIED" });
    ackBroadcastFailed.mockResolvedValue({ publicId: "x", status: "FAILED" });
});

afterEach(() => vi.restoreAllMocks());

describe("runPendingRecruitingBroadcasts", () => {
    it("выбирает получателей по статусам зеркальных стадий и городу снимка", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()], stages: ["SCREENING", "WAITLIST"] });
        findByStatusWithUser.mockResolvedValue([recipient(101), recipient(102)]);

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(findByStatusWithUser).toHaveBeenCalledWith(
            ["SCREENING", "MANUAL_REVIEW", "WAITLIST", "WAITLIST_HR", "WAITLIST_MENTOR"],
            { city: "Черкаси" },
        );
        expect(api.sendMessage).toHaveBeenCalledWith(101, "У нас відкрилися нові вікна для співбесід!");
        expect(api.sendMessage).toHaveBeenCalledWith(102, "У нас відкрилися нові вікна для співбесід!");
        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 2, failed: 0 });
    });

    it("стадии из ответа API управляют статусами: только SCREENING — без вейтлистов", async () => {
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()], stages: ["SCREENING"] });

        await runPendingRecruitingBroadcasts(makeApi() as never, { delayMs: 0 });

        expect(findByStatusWithUser).toHaveBeenCalledWith(
            ["SCREENING", "MANUAL_REVIEW"],
            { city: "Черкаси" },
        );
    });

    it("заблокировавшие бота считаются в failed, остальные получают рассылку", async () => {
        const api = makeApi();
        api.sendMessage
            .mockRejectedValueOnce(Object.assign(new Error("blocked"), { error_code: 403 }))
            .mockResolvedValueOnce({ message_id: 8 });
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()], stages: ["SCREENING", "WAITLIST"] });
        findByStatusWithUser.mockResolvedValue([recipient(101), recipient(102)]);

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 1, failed: 1 });
    });

    it("больше 500 получателей — BROADCAST_TOO_LARGE без единой отправки", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()], stages: ["SCREENING", "WAITLIST"] });
        findByStatusWithUser.mockResolvedValue(Array.from({ length: 501 }, (_, i) => recipient(1000 + i)));

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackBroadcastFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "BROADCAST_TOO_LARGE",
        );
        expect(ackDone).not.toHaveBeenCalled();
    });

    it("развал всей рассылки (упала выборка) — failed-ack с причиной", async () => {
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()], stages: ["SCREENING", "WAITLIST"] });
        findByStatusWithUser.mockRejectedValue(new Error("db down"));

        await runPendingRecruitingBroadcasts(makeApi() as never, { delayMs: 0 });

        expect(ackBroadcastFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("db down"),
        );
    });

    it("сбой списка pending не бросает", async () => {
        listPendingBroadcasts.mockRejectedValue(new Error("api down"));
        await expect(runPendingRecruitingBroadcasts(makeApi() as never, { delayMs: 0 }))
            .resolves.toEqual({ processed: 0 });
    });
});
