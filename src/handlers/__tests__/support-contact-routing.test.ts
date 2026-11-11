import { beforeEach, describe, expect, it, vi } from "vitest";

const findByTelegramId = vi.fn();
const updateCandidate = vi.fn();
const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();
const createOutgoingTopic = vi.fn();
const messageCreate = vi.fn();
const createTimelineEvent = vi.fn();
const logBusinessEvent = vi.fn();
const redisSet = vi.fn();
const redisEval = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();
const callbackHandlers = new Map<string, (ctx: any) => Promise<void>>();

vi.mock("grammy", () => ({
    Bot: class { },
    Composer: class {
        callbackQuery(name: string, handler: (ctx: any) => Promise<void>) {
            callbackHandlers.set(name, handler);
            return this;
        }
    },
    InlineKeyboard: class {
        text() { return this; }
        danger() { return this; }
    }
}));

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findByTelegramId,
        update: updateCandidate,
    }
}));

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findWithStaffProfileByTelegramId }
}));

vi.mock("../../repositories/support-repository.js", () => ({
    supportRepository: {
        findActiveTicketByUser,
        findActiveOutgoingTopicByUser,
        createOutgoingTopic,
        touchTicket: vi.fn(),
    }
}));

vi.mock("../../repositories/message-repository.js", () => ({
    messageRepository: {
        create: messageCreate,
    }
}));

vi.mock("../../repositories/timeline-repository.js", () => ({
    timelineRepository: {
        createEvent: createTimelineEvent,
    }
}));

vi.mock("../../config.js", () => ({
    MENTOR_IDS: [333],
    HR_IDS: [222],
    ADMIN_IDS: [111],
    TEAM_CHATS: { SUPPORT: -100123 },
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
    }
}));

vi.mock("../../db/core.js", () => ({
    default: {}
}));

vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent,
}));

vi.mock("../../core/redis.js", () => ({
    redis: { set: redisSet, eval: redisEval },
}));

vi.mock("../admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
}));

describe("candidate support routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisSet.mockResolvedValue("OK");
        redisEval.mockResolvedValue(1);
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
        createOutgoingTopic.mockResolvedValue({
            id: 91,
            chatId: BigInt(-1003873088973),
            topicId: 987,
        });
        findByTelegramId.mockResolvedValue({
            id: "cand-1",
            fullName: "Jane Doe",
            city: "Kyiv",
            status: "BLOCKER",
            gender: "female",
            birthDate: new Date("2004-05-10T00:00:00.000Z"),
            candidateDecision: "Бот заблоковано / контакт призупинено",
            user: {
                id: "user-1",
                telegramId: 555n,
                username: "jane",
            },
            location: {
                name: "Smile Park"
            }
        });
    });

    it("contact_recovery из старых сообщений открывает обычный поток HR, без форум-топика", async () => {
        await import("../support.js");
        findWithStaffProfileByTelegramId.mockResolvedValue(null);
        const ctx = {
            from: { id: 555 },
            update: { update_id: 1 },
            session: { step: "idle" },
            answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
            reply: vi.fn().mockResolvedValue({}),
            api: { createForumTopic: vi.fn(), sendMessage: vi.fn() },
        } as any;

        await callbackHandlers.get("contact_recovery")!(ctx);

        expect(ctx.session.step).toBe("support_chat");
        expect(ctx.session.supportData).toEqual({ preferredTarget: "HR" });
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
        expect(logBusinessEvent).toHaveBeenCalledWith(
            expect.objectContaining({ event: "candidate.support.started", stage: "HR", result: "started" }),
        );
        expect(ctx.api.createForumTopic).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledOnce();
    });

    it("вернувшаяся BLOCKER-кандидатка пишет в HR: веб-зеркало, без форум-топика и без «Не вдалося»", async () => {
        const { handleSupportMessage } = await import("../support.js");
        const reply = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 555 },
            chat: { id: 555 },
            message: { message_id: 77, text: "Привіт, хочу відновити контакт" },
            update: { update_id: 2 },
            session: { step: "support_chat", supportData: { preferredTarget: "HR" } },
            api: { createForumTopic: vi.fn(), sendMessage: vi.fn(), copyMessage: vi.fn() },
            reply,
        } as any;

        expect(await handleSupportMessage(ctx)).toBe(true);
        expect(ctx.api.createForumTopic).not.toHaveBeenCalled();
        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
        expect(reply).toHaveBeenCalledWith(expect.stringContaining("Повідомлення надіслано"));
        expect(messageCreate).toHaveBeenCalled();
    });

    it("keeps mentor support open and reports failure when the admin DM fails", async () => {
        findByTelegramId.mockResolvedValueOnce({
            id: "cand-1",
            fullName: "Jane Doe",
            city: "Kyiv",
            status: "DISCOVERY_SCHEDULED",
            gender: "female",
            user: { id: "user-1", telegramId: 555n, username: "jane" },
        });
        const { handleSupportMessage } = await import("../support.js");
        const reply = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 555 },
            chat: { id: 555 },
            message: { message_id: 80, text: "Питання ментору" },
            update: { update_id: 4 },
            session: { step: "support_chat", supportData: { preferredTarget: "MENTOR" } },
            api: { sendMessage: vi.fn().mockRejectedValue(new Error("blocked")), copyMessage: vi.fn() },
            reply,
        } as any;

        expect(await handleSupportMessage(ctx)).toBe(true);
        expect(reply).toHaveBeenCalledWith(expect.stringContaining("Не вдалося надіслати повідомлення"));
        expect(ctx.session.step).toBe("support_chat");
        expect(messageCreate).not.toHaveBeenCalled();
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ stage: "MENTOR", result: "failure" }));
    });

    it("does not send a success reply after forwarding to an active topic fails", async () => {
        findActiveTicketByUser.mockResolvedValueOnce({ id: "ticket-1", topicId: 456 });
        const { handleSupportMessage } = await import("../support.js");
        const reply = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 555 },
            chat: { id: 555 },
            message: { message_id: 81, text: "Ще одне питання" },
            update: { update_id: 5 },
            session: { step: "support_chat", supportData: { preferredTarget: "HR" } },
            api: { copyMessage: vi.fn().mockRejectedValue(new Error("topic closed")) },
            reply,
        } as any;

        expect(await handleSupportMessage(ctx)).toBe(true);
        expect(reply).toHaveBeenCalledOnce();
        expect(reply).toHaveBeenCalledWith(expect.stringContaining("Не вдалося надіслати повідомлення"));
        expect(ctx.session.step).toBe("support_chat");
        expect(createTimelineEvent).not.toHaveBeenCalled();
        expect(logBusinessEvent).toHaveBeenCalledWith(expect.objectContaining({ result: "failure" }));
    });

    /**
     * До 04.09.2026 HR-обращение уходило владельцу в Telegram, и этот тест
     * стерёг честный ответ кандидатке, когда доставка проваливалась.
     *
     * Теперь DM для HR-стадий снят: вебапп — единственный канал, а зеркало
     * (middleware/recruiting-incoming.ts) само повторяет пуш и шлёт владельцу
     * аварийный DM, если и повтор не прошёл. Поэтому здесь проверяется
     * обратное утверждение: обработчик НЕ должен слать ни одного Telegram-
     * сообщения на HR-стадии — иначе вернётся ровно тот дубль, ради снятия
     * которого всё и делалось. Запись в БД и таймлайн при этом обязана
     * сохраниться: без неё обращение исчезнет и из истории кандидатки.
     */
    it("HR-стадия: не шлёт DM вообще, но сохраняет сообщение и отвечает кандидатке", async () => {
        const { handleSupportMessage } = await import("../support.js");
        const reply = vi.fn().mockResolvedValue({});
        const sendMessage = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 555 },
            chat: { id: 555 },
            message: { message_id: 82, text: "Потрібна допомога" },
            update: { update_id: 6 },
            session: { step: "support_chat", supportData: { preferredTarget: "HR" } },
            api: { sendMessage, copyMessage: vi.fn() },
            reply,
        } as any;

        expect(await handleSupportMessage(ctx)).toBe(true);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(reply).toHaveBeenCalledWith(expect.stringContaining("Повідомлення надіслано"));
        expect(ctx.session.step).toBe("idle");
        expect(messageCreate).toHaveBeenCalled();
        expect(logBusinessEvent).toHaveBeenCalledWith(
            expect.objectContaining({ stage: "HR", result: "success" }),
        );
    });
});
