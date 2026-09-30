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
});
