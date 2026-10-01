import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, update } = vi.hoisted(() => ({ findMany: vi.fn(), update: vi.fn() }));

vi.mock("@prisma/client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@prisma/client")>();
    return { ...actual, PrismaClient: class { candidate = { findMany }; } };
});
vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: { update } }));
vi.mock("../../utils/bot-blocked.js", () => ({ isBotBlocked: () => false, handleBlockedCandidate: vi.fn() }));

const HOUR = 60 * 60 * 1000;

function invited(hoursAgo: number, reminderSentAt: Date | null = null) {
    return {
        id: "c1",
        fullName: "Анна",
        interviewInvitedAt: new Date(Date.now() - hoursAgo * HOUR),
        interviewInviteReminderSentAt: reminderSentAt,
        user: { telegramId: 1n },
    };
}

describe("processInviteReminders", () => {
    beforeEach(() => {
        findMany.mockReset();
        update.mockReset();
    });

    it("шлёт напоминание один раз и ставит отметку", async () => {
        const { processInviteReminders } = await import("../invite-reminder.js");
        const bot = { api: { sendMessage: vi.fn() } };
        findMany.mockResolvedValue([invited(24.2)]);

        await processInviteReminders(bot);

        expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith("c1", { interviewInviteReminderSentAt: expect.any(Date) });
    });

    it("не повторяет на следующем тике вокера", async () => {
        // Раньше однократность держало часовое окно при тике раз в 5 минут —
        // около 12 одинаковых напоминаний подряд.
        const { processInviteReminders } = await import("../invite-reminder.js");
        const bot = { api: { sendMessage: vi.fn() } };
        findMany.mockResolvedValue([invited(24.3, new Date())]);

        await processInviteReminders(bot);

        expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("через 48 часов возвращает в резерв, а не в поиск времени", async () => {
        const { processInviteReminders } = await import("../invite-reminder.js");
        const bot = { api: { sendMessage: vi.fn() } };
        findMany.mockResolvedValue([invited(49, new Date())]);

        await processInviteReminders(bot);

        expect(update).toHaveBeenCalledWith("c1", expect.objectContaining({
            status: "WAITLIST_HR",
            currentStep: "INITIAL_TEST",
            interviewInviteReminderSentAt: null,
        }));
    });

    it("напоминание называет точный момент сброса — запрошення + 48 ч по Киеву", async () => {
        // Раньше текст обещал «до кінця дня», а сброс наступал на следующий
        // день в другой час.
        const { processInviteReminders } = await import("../invite-reminder.js");
        const bot = { api: { sendMessage: vi.fn() } };
        // 01.10.2026 11:00 UTC = 14:00 по Киеву (UTC+3); +48 ч = сб 03.10, 14:00.
        const invitedAt = new Date("2026-10-01T11:00:00.000Z");
        findMany.mockResolvedValue([{ ...invited(25), interviewInvitedAt: invitedAt }]);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(invitedAt.getTime() + 25 * HOUR));
        try {
            await processInviteReminders(bot);
        } finally {
            vi.useRealTimers();
        }

        const [, text, options] = bot.api.sendMessage.mock.calls[0]!;
        expect(text).toBe("<b>Запрошення на співбесіду ще діє</b>\n\nОберіть зручний час до сб 03.10, 14:00. Після цього запрошення закриється.");
        expect(options.parse_mode).toBe("HTML");
        expect(options.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(["start_scheduling", "decline_invite"]);
    });

    it("дедлайн около полуночи берёт киевскую дату, а не UTC", async () => {
        const { formatInviteDeadline } = await import("../invite-reminder.js");

        // 30.09 22:30 UTC = 01.10 01:30 Киев; +48 ч = сб 03.10, 01:30.
        expect(formatInviteDeadline(new Date("2026-09-30T22:30:00.000Z"))).toBe("сб 03.10, 01:30");
    });

    it("при сбросе пишет согласованный текст закрытия", async () => {
        const { processInviteReminders } = await import("../invite-reminder.js");
        const bot = { api: { sendMessage: vi.fn() } };
        findMany.mockResolvedValue([invited(49, new Date())]);

        await processInviteReminders(bot);

        expect(bot.api.sendMessage).toHaveBeenCalledWith(
            1,
            "<b>Запрошення закрито</b>\n\nЧас для запису минув, тому анкету повернули в резерв. Якщо з’явиться місце, надішлемо нове запрошення.",
            { parse_mode: "HTML" },
        );
    });
});
