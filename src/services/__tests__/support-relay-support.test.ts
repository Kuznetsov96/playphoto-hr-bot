import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../constants/staff-texts.js", () => ({ STAFF_TEXTS: { "support-thread-ack": "ACK", "support-thread-failed": "FAILED" } }));

const { SupportRelayService } = await import("../support-relay-service.js");
const { AlbumBuffer } = await import("../../utils/album-buffer.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SUPPORT_CHAT = -1001234;
const STAFF_CHAT = 555;
const KUZNETSOV = 1;
const SUPPORT_ACCOUNT = 3;

function setup(threadOverrides: Any = {}) {
    const thread: Any = { id: "t1", userId: "u1", chatId: BigInt(SUPPORT_CHAT), topicId: 77, title: "Бланк · Lviv · Dragon Park 2", status: "WAITING", escalatedToTelegramId: null, ...threadOverrides };
    let messageId = 2000;
    const links: Any[] = [];
    const api: Any = {
        copyMessage: vi.fn(async () => ({ message_id: ++messageId })),
        copyMessages: vi.fn(async (_c: number, _f: number, ids: number[]) => ids.map(() => ({ message_id: ++messageId }))),
        sendMessage: vi.fn(async () => ({ message_id: ++messageId })),
        setMessageReaction: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
        editMessageCaption: vi.fn(async () => true),
    };
    const threads: Any = {
        ensureThread: vi.fn(async () => thread),
        applyStatus: vi.fn(async (_a: Any, t: Any, event: Any) => {
            t.lastEvent = event;
            return t;
        }),
        refreshCardIfStale: vi.fn(async () => undefined),
        noticeIfAway: vi.fn(async (_a: Any, t: Any) => t),
        recreateTopic: vi.fn(),
    };
    const repo: Any = {
        addLink: vi.fn(async (link: Any) => { links.push(link); }),
        findLinkByPrivateMessage: vi.fn(async () => null),
        findLinkByTopicMessage: vi.fn(async () => null),
        update: vi.fn(async (_id: string, data: Any) => Object.assign(thread, data)),
        findByTopic: vi.fn(async (_c: bigint, topicId: number) => (topicId === 77 ? thread : null)),
        findLegacyUserByTopic: vi.fn(async () => null),
    };
    const service = new SupportRelayService({
        threads, repo,
        timeline: vi.fn(async () => undefined),
        albums: new AlbumBuffer(),
        now: () => new Date("2026-10-08T12:00:00Z"),
        albumDelayMs: 0,
        supportChatId: () => SUPPORT_CHAT,
        getStaffChatId: async () => STAFF_CHAT,
        isSupportMember: (id: number) => id === KUZNETSOV || id === SUPPORT_ACCOUNT,
        topicLink: (_c: Any, topicId: number) => `link/${topicId}`,
    } as Any);
    return { service, api, thread, links, repo, threads };
}

const inTopic = (message_id: number, extra: Any = {}): Any => ({
    message_id, chat: { id: SUPPORT_CHAT }, message_thread_id: 77, is_topic_message: true,
    from: { id: SUPPORT_ACCOUNT, first_name: "Olena" }, text: "Привіт)", ...extra,
});
const sender = { id: SUPPORT_ACCOUNT, firstName: "Olena" };

beforeEach(() => vi.clearAllMocks());

describe("відповідь із теми фотографині", () => {
    it("копія фотографині, пара OUT, статус «відповіли»", async () => {
        const { service, api, links, thread } = setup();
        await expect(service.relaySupportMessage(api, { message: inTopic(31), sender })).resolves.toBe("delivered");
        expect(api.copyMessage).toHaveBeenCalledWith(STAFF_CHAT, SUPPORT_CHAT, 31, {});
        expect(links).toContainEqual(expect.objectContaining({ direction: "OUT", topicMessageId: 31, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2001 }));
        expect(thread.lastEvent).toEqual({ kind: "support_reply", actorTelegramId: BigInt(SUPPORT_ACCOUNT) });
    });

    it("службове повідомлення теми не пересилається", async () => {
        const { service, api } = setup();
        await expect(service.relaySupportMessage(api, { message: inTopic(32, { text: undefined, forum_topic_edited: { name: "x" } }), sender })).resolves.toBe("ignored");
        await expect(service.relaySupportMessage(api, { message: inTopic(33, { text: undefined, pinned_message: {} }), sender })).resolves.toBe("ignored");
        expect(api.copyMessage).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("тема не людини (LOGISTICS, General) — нічого", async () => {
        const { service, api } = setup();
        await expect(service.relaySupportMessage(api, { message: inTopic(34, { message_thread_id: 7350 }), sender })).resolves.toBe("ignored");
        await expect(service.relaySupportMessage(api, { message: inTopic(35, { message_thread_id: undefined, is_topic_message: undefined }), sender })).resolves.toBe("ignored");
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("анонімний адмін — пояснення в темі, фотографині нічого", async () => {
        const { service, api } = setup();
        const result = await service.relaySupportMessage(api, { message: inTopic(36, { from: { id: 1087968824, first_name: "Group" }, sender_chat: { id: SUPPORT_CHAT } }), sender: { id: 1087968824, firstName: "Group" } });
        expect(result).toBe("failed");
        expect(api.copyMessage).not.toHaveBeenCalled();
        expect(api.sendMessage.mock.calls[0][1]).toMatch(/^⚠️ Not delivered: you're posting anonymously/);
    });

    it("людина не з підтримки — пояснення в темі", async () => {
        const { service, api } = setup();
        const result = await service.relaySupportMessage(api, { message: inTopic(37, { from: { id: 99, first_name: "Guest" } }), sender: { id: 99, firstName: "Guest" } });
        expect(result).toBe("failed");
        expect(api.sendMessage.mock.calls[0][1]).toMatch(/^⚠️ Not delivered: you're not on the support team list/);
    });

    it("свайп на повідомлення фотографині — відповідь з цитатою", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ threadId: "t1", direction: "IN", topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        await service.relaySupportMessage(api, { message: inTopic(38, { reply_to_message: { message_id: 500 }, quote: { text: "завтра", position: 6 } }), sender });
        expect(api.copyMessage.mock.calls[0][3]).toEqual({ reply_parameters: { message_id: 11, allow_sending_without_reply: true, quote: "завтра", quote_position: 6 } });
    });

    it("звичайне повідомлення в темі має reply на корінь теми — це не цитата", async () => {
        const { service, api, repo } = setup();
        await service.relaySupportMessage(api, { message: inTopic(39, { reply_to_message: { message_id: 77, forum_topic_created: {} } }), sender });
        expect(repo.findLinkByTopicMessage).not.toHaveBeenCalled();
        expect(api.copyMessage.mock.calls[0][3]).toEqual({});
    });

    it("відповідь на пост бота з контекстом — контекст цитатою перед текстом", async () => {
        const { service, api, repo, links } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ threadId: "t1", direction: "CONTEXT", topicMessageId: 600, contextText: "Завдання 08.10: <вітрина>" });
        await service.relaySupportMessage(api, { message: inTopic(40, { text: "Зніми зліва", reply_to_message: { message_id: 600 } }), sender });
        expect(api.copyMessage).not.toHaveBeenCalled();
        expect(api.sendMessage).toHaveBeenCalledWith(STAFF_CHAT, "<blockquote>Завдання 08.10: &lt;вітрина&gt;</blockquote>\nЗніми зліва", { parse_mode: "HTML" });
        expect(links).toContainEqual(expect.objectContaining({ direction: "OUT", contextText: "Завдання 08.10: <вітрина>" }));
    });

    it("фото у відповідь на контекст — контекст у підписі", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ threadId: "t1", direction: "CONTEXT", topicMessageId: 600, contextText: "Завдання" });
        await service.relaySupportMessage(api, { message: inTopic(41, { text: undefined, photo: [{}], caption: "Ось так", reply_to_message: { message_id: 600 } }), sender });
        expect(api.copyMessage.mock.calls[0][3]).toEqual({ caption: "<blockquote>Завдання</blockquote>\nОсь так", parse_mode: "HTML" });
    });

    it("відповідь того, кого покликали, передає його id у статус", async () => {
        const { service, api, thread } = setup({ status: "ESCALATED", escalatedToTelegramId: BigInt(KUZNETSOV) });
        await service.relaySupportMessage(api, { message: inTopic(42, { from: { id: KUZNETSOV, first_name: "Vitalii" } }), sender: { id: KUZNETSOV, firstName: "Vitalii" } });
        expect(thread.lastEvent).toEqual({ kind: "support_reply", actorTelegramId: BigInt(KUZNETSOV) });
    });

    it("фотографиня заблокувала бота — видно в темі", async () => {
        const { service, api, thread } = setup();
        api.copyMessage.mockRejectedValue(Object.assign(new Error("x"), { error_code: 403, description: "Forbidden: bot was blocked by the user" }));
        await expect(service.relaySupportMessage(api, { message: inTopic(43), sender })).resolves.toBe("failed");
        expect(api.sendMessage).toHaveBeenCalledWith(SUPPORT_CHAT, "❌ Not delivered: Бланк blocked the bot.", { message_thread_id: 77, reply_parameters: { message_id: 43, allow_sending_without_reply: true } });
        expect(thread.lastEvent).toBeUndefined();
    });

    it("стара тема тікета — доставка і одне нагадування, де тепер розмова", async () => {
        const { service, api, repo } = setup();
        repo.findLegacyUserByTopic.mockResolvedValue("u1");
        await service.relaySupportMessage(api, { message: inTopic(44, { message_thread_id: 300 }), sender });
        await service.relaySupportMessage(api, { message: inTopic(45, { message_thread_id: 300 }), sender });
        expect(api.copyMessage).toHaveBeenCalledTimes(2);
        const notices = api.sendMessage.mock.calls.filter((c: Any[]) => String(c[1]).startsWith("➡️"));
        expect(notices).toEqual([[SUPPORT_CHAT, "➡️ This conversation now lives here: link/77", { message_thread_id: 300 }]]);
    });

    it("rich message іде запасним шляхом", async () => {
        const { service, api } = setup();
        const fallbackSend = vi.fn(async () => undefined);
        await service.relaySupportMessage(api, { message: inTopic(46, { text: undefined, checklist: { title: "x", tasks: [] } }), sender, fallbackSend });
        expect(fallbackSend).toHaveBeenCalledWith(STAFF_CHAT);
        expect(api.copyMessage).not.toHaveBeenCalled();
    });
});

describe("правки", () => {
    it("правка фотографині змінює копію в темі з форматуванням", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ direction: "IN", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        await service.relayEdit(api, { message_id: 11, chat: { id: STAFF_CHAT }, text: "Нове", entities: [{ type: "bold", offset: 0, length: 4 }] } as Any, "staff");
        expect(api.editMessageText).toHaveBeenCalledWith(SUPPORT_CHAT, 500, "Нове", { entities: [{ type: "bold", offset: 0, length: 4 }] });
    });

    it("правка підпису в темі змінює підпис у фотографині", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ direction: "OUT", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 31, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2001, contextText: null });
        await service.relayEdit(api, { message_id: 31, chat: { id: SUPPORT_CHAT }, caption: "Новий підпис", photo: [{}] } as Any, "support");
        expect(api.editMessageCaption).toHaveBeenCalledWith(STAFF_CHAT, 2001, { caption: "Новий підпис", caption_entities: [] });
    });

    it("правка відповіді з контекстом зберігає цитату", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ direction: "OUT", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 40, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2002, contextText: "Завдання" });
        await service.relayEdit(api, { message_id: 40, chat: { id: SUPPORT_CHAT }, text: "Зніми справа" } as Any, "support");
        expect(api.editMessageText).toHaveBeenCalledWith(STAFF_CHAT, 2002, "<blockquote>Завдання</blockquote>\nЗніми справа", { parse_mode: "HTML" });
    });

    it("«not modified» і повідомлення без пари — тихо", async () => {
        const { service, api, repo } = setup();
        await expect(service.relayEdit(api, { message_id: 1, chat: { id: STAFF_CHAT }, text: "x" } as Any, "staff")).resolves.toBeUndefined();
        repo.findLinkByPrivateMessage.mockResolvedValue({ direction: "IN", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        api.editMessageText.mockRejectedValue(new Error("Bad Request: message is not modified"));
        await expect(service.relayEdit(api, { message_id: 11, chat: { id: STAFF_CHAT }, text: "x" } as Any, "staff")).resolves.toBeUndefined();
    });
});

describe("реакції", () => {
    const reaction = (chatId: number, messageId: number, userId: number, emojis: string[]): Any => ({
        chat: { id: chatId }, message_id: messageId, user: { id: userId, is_bot: false },
        old_reaction: [], new_reaction: emojis.map(emoji => ({ type: "emoji", emoji })),
    });

    it("👍 підтримки на повідомленні фотографині — їй видно, тема «відповіли»", async () => {
        const { service, api, repo, thread } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ thread, threadId: "t1", direction: "IN", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        await service.relayReaction(api, reaction(SUPPORT_CHAT, 500, SUPPORT_ACCOUNT, ["👍"]), "support");
        expect(api.setMessageReaction).toHaveBeenCalledWith(STAFF_CHAT, 11, [{ type: "emoji", emoji: "👍" }]);
        expect(thread.lastEvent).toEqual({ kind: "support_thumbs_up", actorTelegramId: BigInt(SUPPORT_ACCOUNT) });
    });

    it("інша реакція підтримки статус не змінює", async () => {
        const { service, api, repo, thread } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ thread, threadId: "t1", direction: "IN", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        await service.relayReaction(api, reaction(SUPPORT_CHAT, 500, SUPPORT_ACCOUNT, ["❤"]), "support");
        expect(api.setMessageReaction).toHaveBeenCalled();
        expect(thread.lastEvent).toBeUndefined();
    });

    it("реакція фотографині на відповідь — на оригіналі в темі", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ direction: "OUT", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 31, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2001 });
        await service.relayReaction(api, reaction(STAFF_CHAT, 2001, 555, ["❤"]), "staff");
        expect(api.setMessageReaction).toHaveBeenCalledWith(SUPPORT_CHAT, 31, [{ type: "emoji", emoji: "❤" }]);
    });

    it("зняту реакцію знімає й на парі", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByPrivateMessage.mockResolvedValue({ direction: "OUT", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 31, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2001 });
        await service.relayReaction(api, reaction(STAFF_CHAT, 2001, 555, []), "staff");
        expect(api.setMessageReaction).toHaveBeenCalledWith(SUPPORT_CHAT, 31, []);
    });

    it("реакція не з підтримки в темі не пересилається", async () => {
        const { service, api, repo } = setup();
        repo.findLinkByTopicMessage.mockResolvedValue({ direction: "IN", topicChatId: BigInt(SUPPORT_CHAT), topicMessageId: 500, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 11 });
        await service.relayReaction(api, reaction(SUPPORT_CHAT, 500, 99, ["👍"]), "support");
        expect(api.setMessageReaction).not.toHaveBeenCalled();
    });
});

describe("повідомлення з адмінки бота", () => {
    const ADMIN_CHAT = 3;
    const adminMessage: Any = { message_id: 70, chat: { id: ADMIN_CHAT }, text: "Завтра заміна" };

    it("фотографині — копія, у тему — рядок і копія, пара OUT, посилання на тему", async () => {
        const { service, api, links, thread } = setup();
        const result = await service.sendFromAdminPanel(api, { adminChatId: ADMIN_CHAT, message: adminMessage, admin: { id: SUPPORT_ACCOUNT, firstName: "Olena" }, userId: "u1" });
        expect(api.copyMessage.mock.calls[0]).toEqual([STAFF_CHAT, ADMIN_CHAT, 70]);
        expect(api.sendMessage).toHaveBeenCalledWith(SUPPORT_CHAT, "↗ Sent from the bot by Olena", { message_thread_id: 77 });
        expect(api.copyMessage.mock.calls[1]).toEqual([SUPPORT_CHAT, ADMIN_CHAT, 70, { message_thread_id: 77 }]);
        expect(links).toContainEqual(expect.objectContaining({ direction: "OUT", topicMessageId: 2003, privateChatId: BigInt(STAFF_CHAT), privateMessageId: 2001 }));
        expect(thread.lastEvent).toEqual({ kind: "support_reply", actorTelegramId: BigInt(SUPPORT_ACCOUNT) });
        expect(result).toEqual({ topicUrl: "link/77", title: "Бланк · Lviv · Dragon Park 2" });
    });

    it("фотографині не дійшло — помилка, у тему нічого", async () => {
        const { service, api } = setup();
        api.copyMessage.mockRejectedValueOnce(new Error("Forbidden: bot was blocked by the user"));
        await expect(service.sendFromAdminPanel(api, { adminChatId: ADMIN_CHAT, message: adminMessage, admin: { id: SUPPORT_ACCOUNT, firstName: "Olena" }, userId: "u1" })).rejects.toThrow("blocked");
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("копія в тему не вдалась — повідомлення вже доставлене, не помилка", async () => {
        const { service, api } = setup();
        api.copyMessage.mockResolvedValueOnce({ message_id: 2001 }).mockRejectedValueOnce(new Error("Bad Request: not enough rights"));
        await expect(service.sendFromAdminPanel(api, { adminChatId: ADMIN_CHAT, message: adminMessage, admin: { id: SUPPORT_ACCOUNT, firstName: "Olena" }, userId: "u1" })).resolves.toMatchObject({ topicUrl: "link/77" });
    });
});
