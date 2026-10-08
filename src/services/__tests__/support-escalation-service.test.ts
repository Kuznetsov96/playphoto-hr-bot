import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { SupportEscalationService } = await import("../support-escalation-service.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const CHAT = -1001234;
const KUZNETSOV = 11;
const HUPALOVA = 22;
const SUPPORT = 33;

function setup(threadOverrides: Any = {}, targets: Any = { kuznetsov: KUZNETSOV, hupalova: HUPALOVA, support: SUPPORT }) {
    const thread: Any = {
        id: "t1", userId: "u1", chatId: BigInt(CHAT), topicId: 77, title: "Бланк · Lviv · Dragon Park 2",
        status: "WAITING", escalatedToTelegramId: null, lastQuestionAt: null, lastSupportAt: null, ...threadOverrides,
    };
    let messageId = 300;
    const api: Any = {
        sendMessage: vi.fn(async () => ({ message_id: ++messageId })),
        copyMessage: vi.fn(async () => ({ message_id: ++messageId })),
    };
    const threads: Any = {
        applyStatus: vi.fn(async (_a: Any, t: Any, event: Any) => {
            t.lastEvent = event;
            if (event.kind === "escalated") Object.assign(t, { status: "ESCALATED", escalatedToTelegramId: event.targetTelegramId });
            if (event.kind === "back_to_support") Object.assign(t, { status: event.hasUnansweredQuestion ? "WAITING" : "ANSWERED", escalatedToTelegramId: null });
            return t;
        }),
    };
    const repo: Any = {
        findById: vi.fn(async () => thread),
        listIncomingSince: vi.fn(async () => [{ topicMessageId: 503 }, { topicMessageId: 502 }, { topicMessageId: 501 }]),
    };
    const service = new SupportEscalationService({ threads, repo, targets: () => targets, topicLink: () => "https://t.me/c/1234/77" });
    return { service, api, thread, threads, repo };
}

const caller = { id: SUPPORT, firstName: "Olena" };

beforeEach(() => vi.clearAllMocks());

describe("покликати", () => {
    it("ставить ескалацію на Кузнєцова", async () => {
        const { service, api, thread } = setup();
        await service.call(api, "t1", "kuznetsov", caller);
        expect(thread.lastEvent).toEqual({ kind: "escalated", targetTelegramId: BigInt(KUZNETSOV) });
    });

    it("рядок у темі згадує його і має кнопку повернення", async () => {
        const { service, api } = setup();
        await service.call(api, "t1", "kuznetsov", caller);
        const [chat, text, options] = api.sendMessage.mock.calls[0];
        expect(chat).toBe(CHAT);
        expect(text).toBe(`🔔 <a href="tg://user?id=${KUZNETSOV}">Kuznetsov</a>, you're needed here · called by Olena`);
        expect(options).toMatchObject({ message_thread_id: 77, parse_mode: "HTML" });
        expect(JSON.stringify(options.reply_markup)).toContain("sth:b:t1");
    });

    it("у приватні — назва теми, кнопки і до трьох повідомлень без відповіді від старшого до новішого", async () => {
        const { service, api, repo } = setup({ lastSupportAt: new Date("2026-10-08T10:00:00Z") });
        await service.call(api, "t1", "hupalova", caller);
        const dm = api.sendMessage.mock.calls[1];
        expect(dm[0]).toBe(HUPALOVA);
        expect(dm[1]).toBe("🔔 Olena called you to <b>Бланк · Lviv · Dragon Park 2</b>");
        expect(JSON.stringify(dm[2].reply_markup)).toContain("https://t.me/c/1234/77");
        expect(JSON.stringify(dm[2].reply_markup)).toContain("sth:b:t1");
        expect(repo.listIncomingSince).toHaveBeenCalledWith("t1", new Date("2026-10-08T10:00:00Z"), 3);
        expect(api.copyMessage.mock.calls.map((c: Any[]) => c[2])).toEqual([501, 502, 503]);
        expect(api.copyMessage.mock.calls[0][0]).toBe(HUPALOVA);
    });

    it("особисті не дійшли — рядок у темі все одно є", async () => {
        const { service, api } = setup();
        api.sendMessage.mockImplementation(async (chat: number) => {
            if (chat === KUZNETSOV) throw new Error("Forbidden: bot can't initiate conversation with a user");
            return { message_id: 1 };
        });
        await expect(service.call(api, "t1", "kuznetsov", caller)).resolves.toBeUndefined();
        expect(api.sendMessage.mock.calls[0][0]).toBe(CHAT);
    });

    it("подвійне натискання — одне покликання", async () => {
        const { service, api } = setup();
        await service.call(api, "t1", "kuznetsov", caller);
        await service.call(api, "t1", "kuznetsov", caller);
        expect(api.sendMessage.mock.calls.filter((c: Any[]) => c[0] === CHAT)).toHaveLength(1);
        expect(api.sendMessage.mock.calls.filter((c: Any[]) => c[0] === KUZNETSOV)).toHaveLength(1);
    });

    it("покликали, повернули, покликали знову — друге покликання спрацьовує", async () => {
        const { service, api } = setup();
        await service.call(api, "t1", "kuznetsov", caller);
        await service.backToSupport(api, "t1", { id: KUZNETSOV, firstName: "Vitalii" });
        await service.call(api, "t1", "kuznetsov", caller);
        expect(api.sendMessage.mock.calls.filter((c: Any[]) => c[0] === KUZNETSOV)).toHaveLength(2);
    });

    it("ціль не налаштована — помилка, статус не змінюється", async () => {
        const { service, api, thread } = setup({}, { kuznetsov: undefined, hupalova: HUPALOVA, support: SUPPORT });
        await expect(service.call(api, "t1", "kuznetsov", caller)).rejects.toThrow("not configured");
        expect(thread.lastEvent).toBeUndefined();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe("повернути в Support", () => {
    it("питання без відповіді — тема знову «чекає», згадка Support", async () => {
        const { service, api, thread } = setup({
            status: "ESCALATED", escalatedToTelegramId: BigInt(KUZNETSOV),
            lastQuestionAt: new Date("2026-10-08T11:00:00Z"), lastSupportAt: new Date("2026-10-08T10:00:00Z"),
        });
        await expect(service.backToSupport(api, "t1", { id: KUZNETSOV, firstName: "Vitalii" })).resolves.toBe(true);
        expect(thread.lastEvent).toEqual({ kind: "back_to_support", hasUnansweredQuestion: true });
        expect(api.sendMessage).toHaveBeenCalledWith(CHAT, `↩ Back to <a href="tg://user?id=${SUPPORT}">Support</a> · from Vitalii`, { message_thread_id: 77, parse_mode: "HTML" });
    });

    it("відповідь уже була — «відповіли»", async () => {
        const { service, api, thread } = setup({
            status: "ESCALATED", escalatedToTelegramId: BigInt(KUZNETSOV),
            lastQuestionAt: new Date("2026-10-08T10:00:00Z"), lastSupportAt: new Date("2026-10-08T11:00:00Z"),
        });
        await service.backToSupport(api, "t1", { id: KUZNETSOV, firstName: "Vitalii" });
        expect(thread.lastEvent).toEqual({ kind: "back_to_support", hasUnansweredQuestion: false });
    });

    it("тема вже не в ескалації — нічого, false", async () => {
        const { service, api, thread } = setup({ status: "ANSWERED" });
        await expect(service.backToSupport(api, "t1", { id: KUZNETSOV, firstName: "Vitalii" })).resolves.toBe(false);
        expect(thread.lastEvent).toBeUndefined();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});
