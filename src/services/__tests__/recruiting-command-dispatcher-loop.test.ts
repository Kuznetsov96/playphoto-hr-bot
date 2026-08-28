import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `worker.ts` тянет большой граф зависимостей (prisma, репозитории, другие
// циклы). Этому тесту важны только флаг AWS_RECRUITING_COMMANDS_ENABLED и
// диспетчер, который он гейтит, — остальное замокано, чтобы импорт не требовал
// живой базы и внешних сервисов.
const runOnce = vi.fn().mockResolvedValue(undefined);

vi.mock("../recruiting-command-dispatcher.js", () => ({
    recruitingCommandDispatcher: { runOnce },
}));
vi.mock("../schedule-notification-dispatcher.js", () => ({
    scheduleNotificationDispatcher: { runOnce: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../replacement-notification-dispatcher.js", () => ({
    createReplacementNotificationDispatcher: vi.fn().mockReturnValue({ dispatchPending: vi.fn() }),
}));
vi.mock("../access-revocation-dispatcher.js", () => ({
    runAccessRevocations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn(), eval: vi.fn() }, default: {} }));
vi.mock("../../db/core.js", () => ({ default: {} }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../repositories/interview-repository.js", () => ({ interviewRepository: {} }));
vi.mock("../../repositories/training-repository.js", () => ({ trainingRepository: {} }));
vi.mock("../task-service.js", () => ({ taskService: {} }));
vi.mock("../hr-service.js", () => ({ notifyMentors: vi.fn() }));
vi.mock("../../workers/invite-reminder.js", () => ({ processInviteReminders: vi.fn() }));
vi.mock("../../repositories/session-repository.js", () => ({ sessionRepository: {} }));
vi.mock("../funnel-anomaly-detector.js", () => ({ isImpossibleMentorState: vi.fn() }));

let configOverrides: { AWS_RECRUITING_COMMANDS_ENABLED: boolean };
vi.mock("../../config.js", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../../config.js");
    return {
        ...actual,
        get AWS_RECRUITING_COMMANDS_ENABLED() {
            return configOverrides.AWS_RECRUITING_COMMANDS_ENABLED;
        },
    };
});

const fakeBotApi = { sendMessage: vi.fn() };
const fakeBot = { api: fakeBotApi } as never as import("grammy").Bot<import("../../types/context.js").MyContext>;

describe("startRecruitingCommandDispatcher", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetModules();
    });

    it("creates no timer and never polls when the flag is off", async () => {
        configOverrides = { AWS_RECRUITING_COMMANDS_ENABLED: false };
        const { startRecruitingCommandDispatcher } = await import("../worker.js");

        const timer = startRecruitingCommandDispatcher(fakeBot);

        expect(timer).toBeUndefined();
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(runOnce).not.toHaveBeenCalled();
    });

    it("polls every 60s with the bot's shared api when the flag is on", async () => {
        configOverrides = { AWS_RECRUITING_COMMANDS_ENABLED: true };
        const { startRecruitingCommandDispatcher } = await import("../worker.js");

        const timer = startRecruitingCommandDispatcher(fakeBot);

        expect(timer).toBeDefined();
        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(runOnce).toHaveBeenCalledTimes(1);
        // Тот же общий Api инстанс бота — не new Bot() на каждый вызов.
        expect(runOnce).toHaveBeenCalledWith(fakeBotApi);

        clearInterval(timer);
    });

    it("swallows a failed iteration instead of throwing out of the interval", async () => {
        configOverrides = { AWS_RECRUITING_COMMANDS_ENABLED: true };
        runOnce.mockRejectedValueOnce(new Error("upstream down"));
        const { startRecruitingCommandDispatcher } = await import("../worker.js");

        const timer = startRecruitingCommandDispatcher(fakeBot);
        await vi.advanceTimersByTimeAsync(60 * 1000);

        expect(runOnce).toHaveBeenCalledTimes(1);
        clearInterval(timer);
    });
});
