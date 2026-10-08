import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сквозний сценарій постійної теми на справжніх сервісах (тема, пересилання,
 * ескалація) з базою в пам'яті й підробленим Telegram. Ловить те, що ховають
 * заглушки в модульних тестах: чи сходяться id пар, статуси, цитати між сервісами.
 */

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../constants/staff-texts.js", () => ({ STAFF_TEXTS: { "support-thread-ack": "ACK", "support-thread-failed": "FAILED" } }));

const { SupportThreadService } = await import("../support-thread-service.js");
const { SupportRelayService } = await import("../support-relay-service.js");
const { SupportEscalationService } = await import("../support-escalation-service.js");
const { AlbumBuffer } = await import("../../utils/album-buffer.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SUPPORT_CHAT = -1001234;
const STAFF_CHAT = 555;
const KUZNETSOV = 11;
const HUPALOVA = 22;
const SUPPORT = 33;

function memoryRepo() {
    const threads = new Map<string, Any>();
    const links: Any[] = [];
    let seq = 0;
    const withThread = (link: Any) => (link ? { ...link, thread: threads.get(link.threadId) } : null);
    return {
        threads, links,
        findByUserId: async (userId: string) => [...threads.values()].find(t => t.userId === userId) ?? null,
        findById: async (id: string) => threads.get(id) ?? null,
        findByTopic: async (chatId: bigint, topicId: number) => [...threads.values()].find(t => t.chatId === chatId && t.topicId === topicId) ?? null,
        create: async (data: Any) => {
            const row = { id: `t${++seq}`, status: "ANSWERED", escalatedToTelegramId: null, cardMessageId: null, cardDay: null, noticeDay: null, lastStaffAt: null, lastQuestionAt: null, lastSupportAt: null, archivedAt: null, updatedAt: new Date(), ...data };
            threads.set(row.id, row);
            return row;
        },
        update: async (id: string, data: Any) => {
            const row = { ...threads.get(id), ...data };
            threads.set(id, row);
            return row;
        },
        listByStatusNot: async (status: string) => [...threads.values()].filter(t => t.status !== status),
        listCollidingSurnames: async () => new Set<string>(),
        addLink: async (link: Any) => {
            if (links.some(l => l.topicChatId === link.topicChatId && l.topicMessageId === link.topicMessageId)) return;
            links.push({ id: links.length + 1, createdAt: new Date(), privateChatId: null, privateMessageId: null, contextText: null, ...link });
        },
        findLinkByTopicMessage: async (chatId: bigint, messageId: number) => withThread(links.find(l => l.topicChatId === chatId && l.topicMessageId === messageId)),
        findLinkByPrivateMessage: async (chatId: bigint, messageId: number) => withThread(links.find(l => l.privateChatId === chatId && l.privateMessageId === messageId)),
        listIncomingSince: async (threadId: string, since: Date | null, limit: number) =>
            links.filter(l => l.threadId === threadId && l.direction === "IN" && (!since || l.createdAt > since)).reverse().slice(0, limit),
        findLegacyUserByTopic: async () => null,
    };
}

function fakeTelegram() {
    const counters = new Map<number, number>();
    const sent: { chat: number; method: string; args: Any[]; id: number }[] = [];
    const next = (chat: number) => {
        const id = (counters.get(chat) ?? 100) + 1;
        counters.set(chat, id);
        return id;
    };
    const record = (method: string, chat: number, args: Any[]) => {
        const id = next(chat);
        sent.push({ chat, method, args, id });
        return { message_id: id };
    };
    const api: Any = {
        createForumTopic: vi.fn(async () => ({ message_thread_id: 77 })),
        editForumTopic: vi.fn(async () => true),
        pinChatMessage: vi.fn(async () => true),
        closeForumTopic: vi.fn(async () => true),
        sendMessage: vi.fn(async (chat: number, ...args: Any[]) => record("sendMessage", chat, args)),
        copyMessage: vi.fn(async (chat: number, ...args: Any[]) => record("copyMessage", chat, args)),
        copyMessages: vi.fn(async (chat: number, from: number, ids: number[], ...rest: Any[]) => ids.map(() => record("copyMessages", chat, [from, ids, ...rest]))),
        setMessageReaction: vi.fn(async () => true),
        editMessageText: vi.fn(async () => true),
        editMessageCaption: vi.fn(async () => true),
    };
    return { api, sent };
}

function world() {
    const repo = memoryRepo();
    const { api, sent } = fakeTelegram();
    const threads = new SupportThreadService({
        repo: repo as Any,
        people: {
            getPerson: async () => ({ userId: "u1", staffId: "s1", fullName: "Бланк Анастасія", surnameNameDot: "Бланк А.", phone: null, username: null, isActive: true, homeLocation: { id: "dp2", name: "Dragon Park 2", branch: null, city: "Lviv" } }),
            recentShiftLocations: async () => [],
            todayShift: async () => null,
        },
        lock: async (_u, fn) => fn(),
        chatId: () => SUPPORT_CHAT,
        icons: async () => ({ WAITING: "w", ANSWERED: "a", ESCALATED: "e", ARCHIVED: "r" }),
        sleep: async () => undefined,
        callTargets: () => ({ kuznetsov: KUZNETSOV, hupalova: HUPALOVA }),
    });
    let clock = new Date("2026-10-08T12:00:00Z");
    const relay = new SupportRelayService({
        threads, repo: repo as Any,
        timeline: async () => undefined,
        albums: new AlbumBuffer(),
        now: () => clock,
        albumDelayMs: 0,
        supportChatId: () => SUPPORT_CHAT,
        getStaffChatId: async () => STAFF_CHAT,
        isSupportMember: id => [KUZNETSOV, HUPALOVA, SUPPORT].includes(id),
        topicLink: (_c, t) => `link/${t}`,
        ignoredTopicIds: () => [7350],
    });
    const escalation = new SupportEscalationService({
        threads, repo: repo as Any,
        targets: () => ({ kuznetsov: KUZNETSOV, hupalova: HUPALOVA, support: SUPPORT }),
        topicLink: (_c, t) => `link/${t}`,
    });
    const thread = () => [...repo.threads.values()][0];
    return { repo, api, sent, relay, escalation, thread, tick: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

const staffMsg = (id: number, extra: Any = {}): Any => ({ message_id: id, chat: { id: STAFF_CHAT, type: "private" }, date: 0, text: "Питання", ...extra });
const topicMsg = (id: number, from: number, extra: Any = {}): Any => ({ message_id: id, chat: { id: SUPPORT_CHAT, type: "supergroup" }, date: 0, message_thread_id: 77, is_topic_message: true, from: { id: from, first_name: "X" }, text: "Відповідь", ...extra });

beforeEach(() => vi.clearAllMocks());

describe("повна розмова в постійній темі", () => {
    it("питання → відповідь із цитатою → свайп фотографині → правка → 👍 → покликати → повернути", async () => {
        const w = world();

        // 1. Фотографиня питає
        await w.relay.relayStaffMessage(w.api, { userId: "u1", chatId: STAFF_CHAT, message: staffMsg(10, { text: "Можна завтра о 10?" }), contexts: [] });
        expect(w.api.createForumTopic).toHaveBeenCalledTimes(1);
        expect(w.thread().status).toBe("WAITING");
        const staffCopy = w.repo.links.find(l => l.direction === "IN" && l.privateMessageId === 10)!;
        expect(w.sent.find(s => s.chat === STAFF_CHAT && s.method === "sendMessage")?.args[0]).toBe("ACK");

        // 2. Support відповідає свайпом на її повідомлення з цитатою
        await w.relay.relaySupportMessage(w.api, { message: topicMsg(500, SUPPORT, { reply_to_message: { message_id: staffCopy.topicMessageId }, quote: { text: "о 10", position: 14 } }), sender: { id: SUPPORT, firstName: "Olena" } });
        const toStaff = w.sent.filter(s => s.chat === STAFF_CHAT && s.method === "copyMessage").at(-1)!;
        expect(toStaff.args[2]).toEqual({ reply_parameters: { message_id: 10, allow_sending_without_reply: true, quote: "о 10", quote_position: 14 } });
        expect(w.thread().status).toBe("ANSWERED");

        // 3. Фотографиня відповідає свайпом на відповідь
        await w.relay.relayStaffMessage(w.api, { userId: "u1", chatId: STAFF_CHAT, message: staffMsg(11, { text: "А о 11?", reply_to_message: { message_id: toStaff.id } }), contexts: [] });
        const toTopic = w.sent.filter(s => s.chat === SUPPORT_CHAT && s.method === "copyMessage").at(-1)!;
        expect(toTopic.args[2]).toEqual({ message_thread_id: 77, reply_parameters: { message_id: 500, allow_sending_without_reply: true } });
        expect(w.thread().status).toBe("WAITING");

        // 4. Support править свою відповідь — правка доходить
        await w.relay.relayEdit(w.api, topicMsg(500, SUPPORT, { text: "Можна о 10:30" }), "support");
        expect(w.api.editMessageText).toHaveBeenCalledWith(STAFF_CHAT, toStaff.id, "Можна о 10:30", { entities: [] });

        // 5. 👍 від Support на її другому повідомленні
        const second = w.repo.links.find(l => l.direction === "IN" && l.privateMessageId === 11)!;
        await w.relay.relayReaction(w.api, { chat: { id: SUPPORT_CHAT, type: "supergroup" }, message_id: second.topicMessageId, user: { id: SUPPORT, is_bot: false, first_name: "O" }, date: 0, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } as Any, "support");
        expect(w.api.setMessageReaction).toHaveBeenLastCalledWith(STAFF_CHAT, 11, [{ type: "emoji", emoji: "👍" }]);
        expect(w.thread().status).toBe("ANSWERED");

        // 6. Нове питання, менеджерка кличе Кузнєцова; її власна відповідь ескалацію не знімає
        w.tick(60_000);
        await w.relay.relayStaffMessage(w.api, { userId: "u1", chatId: STAFF_CHAT, message: staffMsg(12, { text: "А зарплата коли?" }), contexts: [] });
        await w.escalation.call(w.api, w.thread().id, "kuznetsov", { id: SUPPORT, firstName: "Olena" });
        expect(w.thread().status).toBe("ESCALATED");
        const dmCopies = w.sent.filter(s => s.chat === KUZNETSOV && s.method === "copyMessage");
        expect(dmCopies.length).toBeGreaterThanOrEqual(1);
        await w.relay.relaySupportMessage(w.api, { message: topicMsg(510, SUPPORT, { text: "Зараз уточню" }), sender: { id: SUPPORT, firstName: "Olena" } });
        expect(w.thread().status).toBe("ESCALATED");

        // 7. Кузнєцов відповідає — ескалація знята
        await w.relay.relaySupportMessage(w.api, { message: topicMsg(520, KUZNETSOV, { text: "У пʼятницю" }), sender: { id: KUZNETSOV, firstName: "Vitalii" } });
        expect(w.thread().status).toBe("ANSWERED");
        expect(w.thread().escalatedToTelegramId).toBeNull();

        // 8. «Дякую» — статус лишається, текстового підтвердження немає
        const acksBefore = w.sent.filter(s => s.chat === STAFF_CHAT && s.args[0] === "ACK").length;
        await w.relay.relayStaffMessage(w.api, { userId: "u1", chatId: STAFF_CHAT, message: staffMsg(13, { text: "Дякую!" }), contexts: [] });
        expect(w.thread().status).toBe("ANSWERED");
        expect(w.sent.filter(s => s.chat === STAFF_CHAT && s.args[0] === "ACK").length).toBe(acksBefore);

        // Тема одна на всю розмову
        expect(w.api.createForumTopic).toHaveBeenCalledTimes(1);
    });

    it("повернути в Support після питання без відповіді — тема знову чекає", async () => {
        const w = world();
        await w.relay.relayStaffMessage(w.api, { userId: "u1", chatId: STAFF_CHAT, message: staffMsg(20), contexts: [] });
        await w.escalation.call(w.api, w.thread().id, "hupalova", { id: SUPPORT, firstName: "Olena" });
        await expect(w.escalation.backToSupport(w.api, w.thread().id, { id: HUPALOVA, firstName: "Alyona" })).resolves.toBe(true);
        expect(w.thread().status).toBe("WAITING");
    });

    it("відповідь на звіт бота приходить фотографині з цитатою задачі", async () => {
        const w = world();
        await w.relay.postBotContext(w.api, "u1", { topicHtml: "📎 <b>Task report</b>", contextText: "Завдання 08.10: вітрина" });
        const report = w.repo.links.find(l => l.direction === "CONTEXT")!;
        await w.relay.relaySupportMessage(w.api, { message: topicMsg(600, SUPPORT, { text: "Переробіть зліва", reply_to_message: { message_id: report.topicMessageId } }), sender: { id: SUPPORT, firstName: "Olena" } });
        const toStaff = w.sent.filter(s => s.chat === STAFF_CHAT).at(-1)!;
        expect(toStaff.args[0]).toBe("<blockquote>Завдання 08.10: вітрина</blockquote>\nПереробіть зліва");
    });
});
