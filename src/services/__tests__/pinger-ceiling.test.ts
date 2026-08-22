import { beforeEach, describe, expect, it, vi } from "vitest";

const findToPing = vi.fn();
const stopTracking = vi.fn();
const trackedUpdate = vi.fn();
const pendingDeleteMany = vi.fn();

vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: {
        findToPing,
        stopTracking,
        update: trackedUpdate,
    },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { deleteMany: pendingDeleteMany },
}));
vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../schedule-sync.js", () => ({ scheduleSyncService: {} }));
vi.mock("../../utils/bot-blocked.js", () => ({ handleBlockedCandidate: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: vi.fn(),
    logSecurityEvent: vi.fn(),
}));

const { runPingerForTest } = await import("../pinger.js");
const { PING_CONFIG } = await import("../../config.js");

/**
 * Пинги в личке: `pruneNonMembersFromPending` трогает только групповые чаты,
 * поэтому положительный `chatId` даёт прямой путь до проверки потолка.
 */
function trackedMessage(broadcastAgeMs: number) {
    return {
        id: 1,
        chatId: 12345,
        messageId: 100,
        lastPingMsgId: null,
        pingIntervalMs: 4 * 60 * 60 * 1000,
        broadcastId: 7,
        broadcast: {
            id: 7,
            createdAt: new Date(Date.now() - broadcastAgeMs),
            messageText: "📢 Побажання на вересень",
        },
        pendingReplies: [{ id: 11, userId: 12345n, status: "pending", user: { telegramId: 12345n } }],
    };
}

function fakeBot() {
    return {
        api: {
            sendMessage: vi.fn().mockResolvedValue({ message_id: 500 }),
            deleteMessage: vi.fn().mockResolvedValue(true),
            getChatMember: vi.fn(),
        },
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("pinger reminder ceiling", () => {
    /**
     * Раньше цикл был бесконечным: `nextPingAt` двигался вперёд без счётчика, и
     * человек, который не отвечает, получал напоминание каждые 4 часа до конца
     * сбора. Молчание всегда имеет причину, которую бот исправить не может.
     */
    it("stops chasing once the broadcast is older than the window", async () => {
        findToPing.mockResolvedValue([trackedMessage(PING_CONFIG.MAX_PING_AGE_MS + 60_000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(stopTracking).toHaveBeenCalledWith(1);
        expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps reminding while the broadcast is inside the window", async () => {
        findToPing.mockResolvedValue([trackedMessage(PING_CONFIG.MAX_PING_AGE_MS - 60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(stopTracking).not.toHaveBeenCalled();
    });

    /**
     * Свойство границы: ровно на потолке напоминание ещё уходит. Строгое `>`
     * выбрано намеренно — иначе окно оказалось бы на один тик короче заявленного.
     */
    it("still sends exactly at the ceiling", async () => {
        findToPing.mockResolvedValue([trackedMessage(PING_CONFIG.MAX_PING_AGE_MS)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    /**
     * Рассылка без `createdAt` не должна молча отключать напоминания: отсутствие
     * даты — это незнание, а не разрешение перестать напоминать.
     */
    it("does not treat a missing broadcast date as an expired one", async () => {
        const message = trackedMessage(0);
        (message as any).broadcast = undefined;
        findToPing.mockResolvedValue([message]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(stopTracking).not.toHaveBeenCalled();
        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    /** Ответившие закрывают трекинг раньше потолка — этот путь не должен ломаться. */
    it("still stops as soon as everyone has answered", async () => {
        const message = trackedMessage(60 * 60 * 1000);
        message.pendingReplies = [];
        findToPing.mockResolvedValue([message]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(stopTracking).toHaveBeenCalledWith(1);
        expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });
});
