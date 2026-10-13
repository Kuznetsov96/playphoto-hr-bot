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

const miniApp = vi.hoisted(() => ({ url: "https://app.example.test" as string | undefined }));
vi.mock("../../config.js", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    get TRAINING_MINIAPP_BASE_URL() {
        return miniApp.url;
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
    miniApp.url = "https://app.example.test";
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

    it("без кнопки шлёт обычный текст", async () => {
        const api = makeApi();
        listPendingMessages.mockResolvedValue({ items: [message({ webAppButton: null })] });
        await deliverPendingRecruitingMessages(api as never);
        expect(api.sendMessage).toHaveBeenCalledWith(1164289764, "Привіт! Це повідомлення від рекрутера.");
    });

    it("прикрепляет web_app кнопку по запросу", async () => {
        const api = makeApi();
        listPendingMessages.mockResolvedValue({
            items: [message({ body: "Навчання чекає", webAppButton: { text: "Продовжити навчання", path: "/learn" } })],
        });
        await deliverPendingRecruitingMessages(api as never);
        const [, , options] = api.sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: { inline_keyboard: unknown[][] } }];
        expect(options.reply_markup.inline_keyboard[0]?.[0]).toEqual({
            text: "Продовжити навчання",
            web_app: { url: "https://app.example.test/learn" },
        });
    });

    it("без базового url кнопка — громкий failed, сообщение не уходит", async () => {
        miniApp.url = undefined;
        const api = makeApi();
        listPendingMessages.mockResolvedValue({
            items: [message({ webAppButton: { text: "Продовжити навчання", path: "/learn" } })],
        });
        const result = await deliverPendingRecruitingMessages(api as never);
        expect(ackMessageFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("miniapp_url_missing"),
        );
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(result).toEqual({ sent: 0, failed: 1 });
    });
});
