import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    // Полдень по Киеву: тесты потолка не должны зависеть от того, ночь ли
    // сейчас на самом деле — иначе они падали бы половину суток.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T09:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("pinger quiet hours", () => {
    /**
     * Раньше интервал в 4 часа ровно укладывался в сутки, и человек получал
     * напоминание в 02:00 каждую ночь, пока не ответит. Половина напоминаний
     * приходилась на нерабочее время — из-за такого отключают уведомления
     * совсем, после чего напоминания перестают работать для всех.
     */
    it("does not send during the night", async () => {
        vi.setSystemTime(new Date("2026-08-26T23:00:00Z")); // 02:00 Kyiv
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    /** Перенос, а не пропуск: пропуск вернул бы нас сюда через минуту, всю ночь. */
    it("reschedules the night reminder for the morning instead of skipping it", async () => {
        vi.setSystemTime(new Date("2026-08-26T23:00:00Z")); // 02:00 Kyiv
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);

        await runPingerForTest(fakeBot());

        expect(trackedUpdate).toHaveBeenCalledTimes(1);
        const moved = trackedUpdate.mock.calls[0]?.[1]?.nextPingAt as Date;
        expect(kyivHourOf(moved)).toBe(10);
    });

    it("sends normally during the working day", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z")); // 14:00 Kyiv
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    /** 18:00 + 6 часов = полночь: без переноса следующий пинг был бы ночным. */
    it("keeps the following reminder out of the night too", async () => {
        vi.setSystemTime(new Date("2026-08-26T15:00:00Z")); // 18:00 Kyiv
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);

        await runPingerForTest(fakeBot());

        const next = trackedUpdate.mock.calls[0]?.[1]?.nextPingAt as Date;
        expect(kyivHourOf(next)).toBe(10);
    });
});

function kyivHourOf(date: Date): number {
    return Number(date.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }));
}
