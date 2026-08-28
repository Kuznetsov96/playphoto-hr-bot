import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Рассылки по пулу города. Список получателей присылает ВЕБАПП — та же
 * выборка, что показала число на кнопке подтверждения; бот не выбирает сам
 * (два словаря городов дали бы разные множества). kind решает содержание:
 * INVITE — стандартное запрошення на выбор слота через hrService
 * (проверки пола/возраста включены), MESSAGE — произвольный текст.
 * Больше 500 получателей — отказ BROADCAST_TOO_LARGE без единой отправки.
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

const findByTelegramId = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId },
}));

const inviteCandidate = vi.fn();

vi.mock("../hr-service.js", () => ({
    hrService: { inviteCandidate },
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
    kind: "MESSAGE",
    body: "У нас відкрилися нові вікна для співбесід!",
    recipients: ["101", "102"],
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    listPendingBroadcasts.mockResolvedValue({ items: [] });
    findByTelegramId.mockImplementation(async (telegramId: number) => ({
        id: `cand-${telegramId}`,
        user: { telegramId: BigInt(telegramId) },
    }));
    inviteCandidate.mockResolvedValue({ ok: true });
    ackDone.mockResolvedValue({ publicId: "x", status: "APPLIED" });
    ackBroadcastFailed.mockResolvedValue({ publicId: "x", status: "FAILED" });
});

afterEach(() => vi.restoreAllMocks());

describe("runPendingRecruitingBroadcasts", () => {
    it("MESSAGE: шлёт текст ровно тем, кого прислал вебапп, без своей выборки", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()] });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(api.sendMessage).toHaveBeenCalledWith(101, "У нас відкрилися нові вікна для співбесід!");
        expect(api.sendMessage).toHaveBeenCalledWith(102, "У нас відкрилися нові вікна для співбесід!");
        expect(findByTelegramId).not.toHaveBeenCalled();
        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 2, failed: 0 });
    });

    it("INVITE: каждому получателю — стандартное запрошення через hrService", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({
            items: [broadcast({ kind: "INVITE", body: null })],
        });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(inviteCandidate).toHaveBeenCalledWith(api, "cand-101");
        expect(inviteCandidate).toHaveBeenCalledWith(api, "cand-102");
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 2, failed: 0 });
    });

    it("INVITE: отказ hrService (пол/возраст/блокировка) и незнакомый tid — честный failed++", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({
            items: [broadcast({ kind: "INVITE", body: null, recipients: ["101", "102", "103"] })],
        });
        inviteCandidate
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false, reason: "age_ineligible" });
        findByTelegramId.mockImplementation(async (telegramId: number) =>
            telegramId === 103 ? null : { id: `cand-${telegramId}`, user: { telegramId: BigInt(telegramId) } });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 1, failed: 2 });
    });

    it("MESSAGE без текста — контрактный failed без единой отправки", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast({ body: null })] });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackBroadcastFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "BROADCAST_BODY_MISSING",
        );
    });

    it("незнакомый kind из более свежего вебаппа — громкий failed, не тихая отправка", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast({ kind: "CAROUSEL" })] });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackBroadcastFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "UNKNOWN_BROADCAST_KIND:CAROUSEL",
        );
    });

    it("заблокировавшие бота считаются в failed, остальные получают рассылку", async () => {
        const api = makeApi();
        api.sendMessage
            .mockRejectedValueOnce(Object.assign(new Error("blocked"), { error_code: 403 }))
            .mockResolvedValueOnce({ message_id: 8 });
        listPendingBroadcasts.mockResolvedValue({ items: [broadcast()] });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(ackDone).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", { sent: 1, failed: 1 });
    });

    it("больше 500 получателей — BROADCAST_TOO_LARGE без единой отправки", async () => {
        const api = makeApi();
        listPendingBroadcasts.mockResolvedValue({
            items: [broadcast({ recipients: Array.from({ length: 501 }, (_, i) => String(1000 + i)) })],
        });

        await runPendingRecruitingBroadcasts(api as never, { delayMs: 0 });

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackBroadcastFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "BROADCAST_TOO_LARGE",
        );
        expect(ackDone).not.toHaveBeenCalled();
    });

    it("сбой списка pending не бросает", async () => {
        listPendingBroadcasts.mockRejectedValue(new Error("api down"));
        await expect(runPendingRecruitingBroadcasts(makeApi() as never, { delayMs: 0 }))
            .resolves.toEqual({ processed: 0 });
    });
});
