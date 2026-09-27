import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findToPing = vi.fn();
const stopTracking = vi.fn();
const trackedUpdate = vi.fn();
const pendingDeleteMany = vi.fn();
const schedulePreferenceSchedule = vi.fn();
const missingSchedulePreferences = vi.fn();
const pendingUpdateMany = vi.fn();

vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: {
        findToPing,
        stopTracking,
        update: trackedUpdate,
    },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { deleteMany: pendingDeleteMany, updateMany: pendingUpdateMany },
}));
vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { schedulePreferenceSchedule, missingSchedulePreferences },
}));
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
        buttonType: "preferences",
        targetMonth: "2026-09",
        pingUntil: null,
        broadcast: {
            id: 7,
            createdAt: new Date(Date.now() - broadcastAgeMs),
            messageText: "📅 <b>Графік на вересень</b>\n\nПривіт! Збираємо побажання на наступний місяць.",
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
    // Сбор открыт, срок — 26 серпня (конец дня по Киеву = 26.08 21:00 UTC).
    schedulePreferenceSchedule.mockResolvedValue({
        month: "2026-09",
        open: true,
        deadline: "2026-08-26",
        deadlineEndsAt: "2026-08-26T21:00:00.000Z",
    });
    // Человек из заготовки (tg 12345) ещё не подал.
    missingSchedulePreferences.mockResolvedValue({
        month: "2026-09",
        items: [{ employeePublicId: "4a1c4f32-2b37-4f0c-9d0c-2d1f7a0c3e11", telegramId: "12345" }],
    });
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

describe("pinger reminder kind", () => {
    /**
     * Тип рассылки берётся из строки трекинга, а не из текста. Пингер искал
     * «Побажання» в тексте; приглашение с 21.08 начинается с «Графік на …», и
     * напоминание уходило как обычная рассылка — с кнопкой «Ознайомлена»,
     * нажатие на которую глушило пинги без поданных пожеланий.
     */
    it("reminds about preferences with the fill button, whatever the invite says", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z")); // 14:00 Kyiv
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        const [, text, options] = bot.api.sendMessage.mock.calls[0]!;
        expect(text).toContain("Нагадуємо про побажання на вересень");
        expect(text).toContain("Останній день — 26 серпня, середа");
        const buttons = options.reply_markup.inline_keyboard.flat();
        expect(buttons.map((button: any) => button.callback_data)).toEqual(["pref_fill"]);
    });

    it("keeps the confirm button for an ordinary broadcast", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z"));
        findToPing.mockResolvedValue([
            { ...trackedMessage(60 * 60 * 1000), buttonType: "default", pingUntil: null },
        ]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        const [, , options] = bot.api.sendMessage.mock.calls[0]!;
        const buttons = options.reply_markup.inline_keyboard.flat();
        expect(buttons.map((button: any) => button.callback_data)).toEqual(["broadcast_confirm_ok_7"]);
    });
});

describe("pinger reads the collection schedule from the web app", () => {
    /** Владелец перенёс срок — напоминание называет новую дату, а не зашитое 26-е. */
    it("names the deadline the owner moved", async () => {
        vi.setSystemTime(new Date("2026-08-28T11:00:00Z"));
        schedulePreferenceSchedule.mockResolvedValue({
            month: "2026-09",
            open: true,
            deadline: "2026-08-29",
            deadlineEndsAt: "2026-08-29T21:00:00.000Z",
        });
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage.mock.calls[0]![1]).toContain("Останній день — 29 серпня, субота");
    });

    /** Закрыли сбор 25-го — раньше бот пинговал до зашитого 26-го. */
    it("stops for good once collection is closed", async () => {
        vi.setSystemTime(new Date("2026-08-25T11:00:00Z"));
        schedulePreferenceSchedule.mockResolvedValue({
            month: "2026-09",
            open: false,
            deadline: "2026-08-26",
            deadlineEndsAt: "2026-08-26T21:00:00.000Z",
        });
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
        expect(stopTracking).toHaveBeenCalledWith(1);
    });

    /** Срок прошёл, но его ещё могут продлить: не бросаем, а проверяем через час. */
    it("waits an hour after the deadline instead of giving up", async () => {
        vi.setSystemTime(new Date("2026-08-27T09:00:00Z"));
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
        expect(stopTracking).not.toHaveBeenCalled();
        const next = trackedUpdate.mock.calls[0]?.[1]?.nextPingAt as Date;
        expect(next.toISOString()).toBe("2026-08-27T10:00:00.000Z");
    });

    it("stops once the schedule month itself is over", async () => {
        vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);

        await runPingerForTest(fakeBot());

        expect(stopTracking).toHaveBeenCalledWith(1);
    });

    /** Иначе при лежащем вебаппе строка возвращалась бы каждую минуту вечно. */
    it("stops at month end even when the web app is down", async () => {
        vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
        schedulePreferenceSchedule.mockRejectedValue(new Error("404"));
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);

        await runPingerForTest(fakeBot());

        expect(stopTracking).toHaveBeenCalledWith(1);
        expect(schedulePreferenceSchedule).not.toHaveBeenCalled();
    });

    /** Вебапп недоступен — ни угаданной даты, ни остановки: повтор на следующем тике. */
    it("sends nothing and keeps the reminder queued when the web app is down", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z"));
        schedulePreferenceSchedule.mockRejectedValue(new Error("timeout"));
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000), { ...trackedMessage(60 * 60 * 1000), id: 2 }]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
        expect(stopTracking).not.toHaveBeenCalled();
        expect(trackedUpdate).not.toHaveBeenCalled();
        // Один запрос на прогон, а не на каждую строку.
        expect(schedulePreferenceSchedule).toHaveBeenCalledTimes(1);
    });
});

describe("pinger checks who has already submitted", () => {
    /** Владелец вписал пожелания за человека в вебаппе — бот об этом не знал и напоминал. */
    it("closes the wait and stops for someone who submitted outside the bot", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z"));
        missingSchedulePreferences.mockResolvedValue({ month: "2026-09", items: [] });
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
        expect(pendingUpdateMany).toHaveBeenCalledWith(
            { trackedMessageId: 1, status: "pending" },
            expect.objectContaining({ status: "confirmed" }),
        );
        expect(stopTracking).toHaveBeenCalledWith(1);
    });

    it("waits for the next tick when the list cannot be read", async () => {
        vi.setSystemTime(new Date("2026-08-26T11:00:00Z"));
        missingSchedulePreferences.mockRejectedValue(new Error("timeout"));
        findToPing.mockResolvedValue([trackedMessage(60 * 60 * 1000)]);
        const bot = fakeBot();

        await runPingerForTest(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
        expect(stopTracking).not.toHaveBeenCalled();
        expect(pendingUpdateMany).not.toHaveBeenCalled();
    });
});

