import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Доставка исходящих сообщений рекрутёра (фаза 3b): веб пишет PENDING в outbox,
 * бот раз в минуту забирает pending, шлёт обычный текст без клавиатуры через
 * общий Api живущего бота и отвечает sent/failed. Заблокировавшая бота
 * кандидатка — честный failed с внятной причиной, а не тихий вечный ретрай.
 */
const listPendingMessages = vi.fn();
const ackSent = vi.fn();
const ackMessageFailed = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingRecruitingMessages: listPendingMessages,
        ackRecruitingMessageSent: ackSent,
        ackRecruitingMessageFailed: ackMessageFailed,
    },
}));

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { deliverPendingRecruitingMessages } = await import("../recruiting-message-delivery.js");

const makeApi = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }) });

const message = (overrides: Partial<Record<string, unknown>> = {}) => ({
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    body: "Привіт! Це повідомлення від рекрутера.",
    telegramId: "1164289764",
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    listPendingMessages.mockResolvedValue({ items: [] });
    ackSent.mockResolvedValue({ publicId: "x", status: "SENT" });
    ackMessageFailed.mockResolvedValue({ publicId: "x", status: "FAILED" });
});

afterEach(() => vi.restoreAllMocks());

describe("deliverPendingRecruitingMessages", () => {
    it("забирает pending с контрактным лимитом 50", async () => {
        await deliverPendingRecruitingMessages(makeApi() as never);
        expect(listPendingMessages).toHaveBeenCalledWith(50);
    });

    it("шлёт текст в чат кандидатки и подтверждает sent с telegramMessageId", async () => {
        const api = makeApi();
        listPendingMessages.mockResolvedValue({ items: [message()] });

        const result = await deliverPendingRecruitingMessages(api as never);

        expect(api.sendMessage).toHaveBeenCalledWith(1164289764, "Привіт! Це повідомлення від рекрутера.");
        expect(ackSent).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", "42");
        expect(ackMessageFailed).not.toHaveBeenCalled();
        expect(result).toEqual({ sent: 1, failed: 0 });
    });

    it("заблокировавшая бота кандидатка — failed-ack с внятной причиной", async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(Object.assign(
            new Error("Call to 'sendMessage' failed!"),
            { error_code: 403, description: "Forbidden: bot was blocked by the user" },
        ));
        listPendingMessages.mockResolvedValue({ items: [message()] });

        const result = await deliverPendingRecruitingMessages(api as never);

        expect(ackMessageFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("BOT_BLOCKED_BY_CANDIDATE"),
        );
        expect(ackSent).not.toHaveBeenCalled();
        expect(result).toEqual({ sent: 0, failed: 1 });
    });

    it("одна упавшая доставка не останавливает очередь", async () => {
        const api = makeApi();
        api.sendMessage
            .mockRejectedValueOnce(new Error("network glitch"))
            .mockResolvedValueOnce({ message_id: 43 });
        listPendingMessages.mockResolvedValue({
            items: [
                message({ publicId: "11111111-1111-4111-8111-111111111111" }),
                message({ publicId: "22222222-2222-4222-8222-222222222222" }),
            ],
        });

        const result = await deliverPendingRecruitingMessages(api as never);

        expect(ackMessageFailed).toHaveBeenCalledWith(
            "11111111-1111-4111-8111-111111111111",
            expect.stringContaining("network glitch"),
        );
        expect(ackSent).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "43");
        expect(result).toEqual({ sent: 1, failed: 1 });
    });

    it("сбой самого списка pending не бросает — просто нулевой проход", async () => {
        listPendingMessages.mockRejectedValue(new Error("api down"));
        await expect(deliverPendingRecruitingMessages(makeApi() as never))
            .resolves.toEqual({ sent: 0, failed: 0 });
    });

    it("потерянный ack не валит проход по остальным", async () => {
        const api = makeApi();
        ackSent.mockRejectedValueOnce(new Error("network"));
        listPendingMessages.mockResolvedValue({
            items: [
                message({ publicId: "11111111-1111-4111-8111-111111111111" }),
                message({ publicId: "22222222-2222-4222-8222-222222222222" }),
            ],
        });

        await deliverPendingRecruitingMessages(api as never);

        expect(ackSent).toHaveBeenCalledTimes(2);
    });
});
