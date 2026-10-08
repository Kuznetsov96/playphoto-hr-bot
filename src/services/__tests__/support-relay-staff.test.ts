import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "support-thread-ack": "ACK",
        "support-thread-failed": "FAILED",
    },
}));

const { SupportRelayService } = await import("../support-relay-service.js");
const { AlbumBuffer } = await import("../../utils/album-buffer.js");

const HOUR = 3_600_000;
const STAFF_CHAT = 555;
const TOPIC_CHAT = -1001234;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function setup(opts: { lastStaffAt?: Date | null; status?: string } = {}) {
    let now = new Date("2026-10-08T12:00:00Z");
    const thread: Any = {
        id: "t1", userId: "u1", chatId: BigInt(TOPIC_CHAT), topicId: 77, status: opts.status ?? "ANSWERED",
        escalatedToTelegramId: null, lastStaffAt: opts.lastStaffAt ?? null,
    };
    const links: Any[] = [];
    let messageId = 1000;
    const api: Any = {
        copyMessage: vi.fn(async () => ({ message_id: ++messageId })),
        copyMessages: vi.fn(async (_c: number, _f: number, ids: number[]) => ids.map(() => ({ message_id: ++messageId }))),
        sendMessage: vi.fn(async () => ({ message_id: ++messageId })),
        setMessageReaction: vi.fn(async () => true),
    };
    const threads: Any = {
        ensureThread: vi.fn(async () => thread),
        applyStatus: vi.fn(async (_api: Any, t: Any, event: Any) => {
            t.lastEvent = event.kind;
            if (event.kind === "staff_question") t.status = "WAITING";
            return t;
        }),
        refreshCardIfStale: vi.fn(async () => undefined),
        noticeIfAway: vi.fn(async (_api: Any, t: Any) => t),
        recreateTopic: vi.fn(async (_api: Any, t: Any) => Object.assign(t, { topicId: 88 })),
    };
    const repo: Any = {
        addLink: vi.fn(async (link: Any) => { links.push(link); }),
        findLinkByPrivateMessage: vi.fn(async () => null),
        findLinkByTopicMessage: vi.fn(async () => null),
        update: vi.fn(async (_id: string, data: Any) => Object.assign(thread, data)),
    };
    const timeline = vi.fn(async () => undefined);
    const service = new SupportRelayService({
        threads, repo, timeline,
        albums: new AlbumBuffer(),
        now: () => now,
        albumDelayMs: 0,
    } as Any);
    return { service, api, thread, links, repo, threads, timeline, setNow: (d: Date) => { now = d; } };
}

const text = (message_id: number, value: string, extra: Any = {}) => ({ message_id, chat: { id: STAFF_CHAT }, text: value, ...extra });

beforeEach(() => vi.clearAllMocks());

describe("повідомлення фотографині в тему", () => {
    it("копія в тему, пара IN, статус «чекає», ✍ і перше підтвердження", async () => {
        const { service, api, links, thread } = setup();
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(11, "Можна завтра вийти?"), contexts: [] });
        expect(result).toBe("delivered");
        expect(api.copyMessage).toHaveBeenCalledWith(TOPIC_CHAT, STAFF_CHAT, 11, { message_thread_id: 77 });
        expect(links).toContainEqual(expect.objectContaining({ direction: "IN", privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11, topicMessageId: 1001 }));
        expect(thread.status).toBe("WAITING");
        expect(api.setMessageReaction).toHaveBeenCalledWith(STAFF_CHAT, 11, [{ type: "emoji", emoji: "✍" }]);
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "ACK");
    });

    it("друге повідомлення за годину — лише ✍, без тексту", async () => {
        const { service, api } = setup({ lastStaffAt: new Date("2026-10-08T11:00:00Z") });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(12, "І ще одне питання"), contexts: [] });
        expect(api.setMessageReaction).toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalledWith(STAFF_CHAT, "ACK");
    });

    it("після 6 годин тиші підтвердження знову", async () => {
        const { service, api } = setup({ lastStaffAt: new Date(Date.parse("2026-10-08T12:00:00Z") - 6 * HOUR) });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(12, "Питання"), contexts: [] });
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "ACK");
    });

    it("«дякую» після тиші — лише ✍ і статус не змінюється", async () => {
        const { service, api, thread } = setup();
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(13, "Добре, дякую"), contexts: [] });
        expect(api.sendMessage).not.toHaveBeenCalledWith(STAFF_CHAT, "ACK");
        expect(thread.lastEvent).toBe("staff_ack");
        expect(thread.status).toBe("ANSWERED");
    });

    it("контекст іде перед копією і запам'ятовується", async () => {
        const { service, api, links } = setup();
        await service.relayStaffMessage(api, {
            userId: "u1", chatId: STAFF_CHAT, message: text(14, "Що саме сфотографувати?"),
            contexts: [{ topicHtml: "❓ <b>Task question</b>", contextText: "Завдання 08.10: вітрина" }],
        });
        const sendOrder = api.sendMessage.mock.invocationCallOrder[0];
        const copyOrder = api.copyMessage.mock.invocationCallOrder[0];
        expect(sendOrder).toBeLessThan(copyOrder);
        expect(api.sendMessage.mock.calls[0]).toEqual([TOPIC_CHAT, "❓ <b>Task question</b>", { message_thread_id: 77, parse_mode: "HTML" }]);
        expect(links).toContainEqual(expect.objectContaining({ direction: "CONTEXT", contextText: "Завдання 08.10: вітрина" }));
    });

    it("свайп на відповідь зі старої теми — без reply, і жодної нової теми", async () => {
        const { service, api, repo, threads } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ threadId: "t1", topicId: 300, topicMessageId: 500, privateMessageId: 40 });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(27, "Так", { reply_to_message: { message_id: 40 } }), contexts: [] });
        expect(api.copyMessage.mock.calls[0][3]).toEqual({ message_thread_id: 77 });
        expect(threads.recreateTopic).not.toHaveBeenCalled();
    });

    it("Telegram відхилив reply — повтор без нього, а не «тема видалена»", async () => {
        const { service, api, repo, threads } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ threadId: "t1", topicId: 77, topicMessageId: 500, privateMessageId: 40 });
        api.copyMessage.mockRejectedValueOnce(Object.assign(new Error("x"), { description: "Bad Request: message thread not found" }));
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(28, "Так", { reply_to_message: { message_id: 40 } }), contexts: [] });
        expect(result).toBe("delivered");
        expect(api.copyMessage.mock.calls[1][3]).toEqual({ message_thread_id: 77 });
        expect(threads.recreateTopic).not.toHaveBeenCalled();
    });

    it("свайп на відповідь підтримки — відповідь у темі з цитатою", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ threadId: "t1", topicId: 77, topicMessageId: 500, privateMessageId: 40 });
        await service.relayStaffMessage(api, {
            userId: "u1", chatId: STAFF_CHAT,
            message: text(15, "Так", { reply_to_message: { message_id: 40 }, quote: { text: "завтра о 10", position: 3 } }),
            contexts: [],
        });
        expect(api.copyMessage.mock.calls[0][3]).toEqual({
            message_thread_id: 77,
            reply_parameters: { message_id: 500, allow_sending_without_reply: true, quote: "завтра о 10", quote_position: 3 },
        });
    });

    it("Telegram не прийняв цитату — повтор без неї", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ threadId: "t1", topicId: 77, topicMessageId: 500, privateMessageId: 40 });
        api.copyMessage.mockRejectedValueOnce(Object.assign(new Error("x"), { description: "Bad Request: QUOTE_TEXT_INVALID" }));
        const result = await service.relayStaffMessage(api, {
            userId: "u1", chatId: STAFF_CHAT,
            message: text(16, "Так", { reply_to_message: { message_id: 40 }, quote: { text: "змінений текст", position: 0 } }),
            contexts: [],
        });
        expect(result).toBe("delivered");
        expect(api.copyMessage.mock.calls[1][3]).toEqual({ message_thread_id: 77, reply_parameters: { message_id: 500, allow_sending_without_reply: true } });
    });

    it("видалена тема — нова тема і повтор", async () => {
        const { service, api, threads } = setup();
        api.copyMessage.mockRejectedValueOnce(Object.assign(new Error("x"), { description: "Bad Request: message thread not found" }));
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(17, "Питання"), contexts: [] });
        expect(result).toBe("delivered");
        expect(threads.recreateTopic).toHaveBeenCalled();
        expect(api.copyMessage.mock.calls[1][3]).toEqual({ message_thread_id: 88 });
    });

    it("друга невдача — фотографиня бачить, що не дійшло", async () => {
        const { service, api } = setup();
        api.copyMessage.mockRejectedValue(Object.assign(new Error("x"), { description: "Internal Server Error" }));
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(18, "Питання"), contexts: [] });
        expect(result).toBe("failed");
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "FAILED");
        expect(api.setMessageReaction).not.toHaveBeenCalled();
    });

    it("тему не вдалося створити — фотографиня бачить збій", async () => {
        const { service, api, threads } = setup();
        threads.ensureThread.mockRejectedValue(new Error("not enough rights"));
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(19, "Питання"), contexts: [] });
        expect(result).toBe("failed");
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "FAILED");
    });

    it("альбом — один copyMessages, одна ✍, три пари", async () => {
        const { service, api, links } = setup();
        const photo = (id: number, caption?: string): Any => ({ message_id: id, chat: { id: STAFF_CHAT }, media_group_id: "g1", photo: [{}], ...(caption ? { caption } : {}) });
        await Promise.all([
            service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(21, "Вітрина"), contexts: [] }),
            service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(22), contexts: [] }),
            service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(23), contexts: [] }),
        ]);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(api.copyMessages).toHaveBeenCalledTimes(1);
        expect(api.copyMessages).toHaveBeenCalledWith(TOPIC_CHAT, STAFF_CHAT, [21, 22, 23], { message_thread_id: 77 });
        expect(api.setMessageReaction).toHaveBeenCalledTimes(1);
        expect(links.filter(l => l.direction === "IN")).toHaveLength(3);
    });

    it("видалена тема на пості контексту — нова тема, контекст і повідомлення доходять", async () => {
        const { service, api, threads } = setup();
        api.sendMessage.mockRejectedValueOnce(Object.assign(new Error("x"), { description: "Bad Request: message thread not found" }));
        const result = await service.relayStaffMessage(api, {
            userId: "u1", chatId: STAFF_CHAT, message: text(25, "Питання"),
            contexts: [{ topicHtml: "❓ ctx", contextText: "ctx" }],
        });
        expect(result).toBe("delivered");
        expect(threads.recreateTopic).toHaveBeenCalled();
        expect(api.sendMessage.mock.calls[1]).toEqual([TOPIC_CHAT, "❓ ctx", { message_thread_id: 88, parse_mode: "HTML" }]);
        expect(api.copyMessage.mock.calls[0][3]).toEqual({ message_thread_id: 88 });
    });

    it("звіт бота у видалену тему — нова тема і звіт доходить", async () => {
        const { service, api, threads } = setup();
        api.sendMessage.mockRejectedValueOnce(Object.assign(new Error("x"), { description: "Bad Request: TOPIC_DELETED" }));
        await service.postBotContext(api, "u1", { topicHtml: "📎 report", contextText: "r" });
        expect(threads.recreateTopic).toHaveBeenCalled();
        expect(api.sendMessage).toHaveBeenLastCalledWith(TOPIC_CHAT, "📎 report", { message_thread_id: 88, parse_mode: "HTML" });
    });

    it("службова подія в приватному чаті (закріп) — нікуди не йде і без «не вдалося»", async () => {
        const { service, api, threads } = setup();
        const result = await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: { message_id: 26, chat: { id: STAFF_CHAT }, pinned_message: {} } as Any, contexts: [] });
        expect(result).toBe("ignored");
        expect(threads.ensureThread).not.toHaveBeenCalled();
        expect(api.copyMessage).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("альбом без явної затримки чекає 2 с — повільна частина не розриває його", async () => {
        vi.useFakeTimers();
        try {
            const { service, api } = setup();
            (service as Any).deps.albumDelayMs = undefined;
            const photo = (id: number): Any => ({ message_id: id, chat: { id: STAFF_CHAT }, media_group_id: "g2", photo: [{}] });
            await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(31), contexts: [] });
            await vi.advanceTimersByTimeAsync(1500);
            await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(32), contexts: [] });
            await vi.advanceTimersByTimeAsync(2000);
            expect(api.copyMessages).toHaveBeenCalledTimes(1);
            expect(api.copyMessages.mock.calls[0][2]).toEqual([31, 32]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("альбом: Telegram скопіював не все — пари не зсуваються", async () => {
        const { service, api, links } = setup();
        api.copyMessages.mockResolvedValueOnce([{ message_id: 901 }, { message_id: 902 }]);
        const photo = (id: number): Any => ({ message_id: id, chat: { id: STAFF_CHAT }, media_group_id: "g3", photo: [{}] });
        await Promise.all([41, 42, 43].map(id => service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(id), contexts: [] })));
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(links.filter(l => l.direction === "IN")).toHaveLength(0);
        expect(api.setMessageReaction).toHaveBeenCalledTimes(1);
    });

    it("альбом не дійшов — фотографиня бачить збій", async () => {
        const { service, api, threads } = setup();
        const photo = (id: number): Any => ({ message_id: id, chat: { id: STAFF_CHAT }, media_group_id: "g4", photo: [{}] });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(44), contexts: [] });
        threads.ensureThread.mockRejectedValueOnce(new Error("db down"));
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "FAILED");
    });

    it("текст одразу після альбому йде в тему після альбому", async () => {
        const { service, api } = setup();
        const photo = (id: number): Any => ({ message_id: id, chat: { id: STAFF_CHAT }, media_group_id: "g5", photo: [{}] });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: photo(45), contexts: [] });
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(46, "Ось звіт"), contexts: [] });
        expect(api.copyMessages.mock.invocationCallOrder[0]).toBeLessThan(api.copyMessage.mock.invocationCallOrder[0]);
    });

    it("пари зберігають номер теми", async () => {
        const { service, api, links } = setup();
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(47, "Питання"), contexts: [] });
        expect(links.find(l => l.direction === "IN")).toMatchObject({ topicId: 77 });
    });

    it("історія пишеться в timeline", async () => {
        const { service, api, timeline } = setup();
        await service.relayStaffMessage(api, { userId: "u1", chatId: STAFF_CHAT, message: text(24, "Питання"), contexts: [] });
        expect(timeline).toHaveBeenCalledWith("u1", "USER", "Питання", { threadId: "t1" });
    });
});
