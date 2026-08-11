import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `worker.ts` pulls in a large dependency graph (prisma, repositories, other
// loops). The only things this test cares about are the feature flag and the
// dispatcher factory it gates — everything else in the module is mocked out
// so the import doesn't require a live database or external service.
const dispatchPending = vi.fn().mockResolvedValue({ delivered: 0, failed: 0 });
const createReplacementNotificationDispatcher = vi.fn().mockReturnValue({ dispatchPending });

vi.mock("../replacement-notification-dispatcher.js", () => ({
    createReplacementNotificationDispatcher,
}));
vi.mock("../schedule-notification-dispatcher.js", () => ({
    scheduleNotificationDispatcher: { runOnce: vi.fn().mockResolvedValue(undefined) },
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

let configOverrides: { AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED: boolean };
vi.mock("../../config.js", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../../config.js");
    return {
        ...actual,
        get AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED() {
            return configOverrides.AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED;
        },
    };
});

const fakeBotApi = { sendMessage: vi.fn() };
const fakeBot = { api: fakeBotApi } as never as import("grammy").Bot<import("../../types/context.js").MyContext>;

describe("startReplacementNotificationDispatcher", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetModules();
    });

    it("creates no timer and never builds the dispatcher when the flag is off", async () => {
        configOverrides = { AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED: false };
        const { startReplacementNotificationDispatcher } = await import("../worker.js");

        const timer = startReplacementNotificationDispatcher(fakeBot);

        expect(timer).toBeUndefined();
        expect(createReplacementNotificationDispatcher).not.toHaveBeenCalled();

        // Advancing time must not cause a poll either — the gate is not just
        // "returns undefined", it must never have started a loop at all.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(dispatchPending).not.toHaveBeenCalled();
    });

    it("polls on an interval and calls dispatchPending when the flag is on", async () => {
        configOverrides = { AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED: true };
        const { startReplacementNotificationDispatcher } = await import("../worker.js");

        const timer = startReplacementNotificationDispatcher(fakeBot);

        expect(timer).toBeDefined();
        expect(createReplacementNotificationDispatcher).toHaveBeenCalledWith(fakeBotApi);

        await vi.advanceTimersByTimeAsync(60 * 1000);
        expect(dispatchPending).toHaveBeenCalledTimes(1);

        clearInterval(timer);
    });

    it("swallows a failed iteration instead of throwing out of the interval", async () => {
        configOverrides = { AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED: true };
        dispatchPending.mockRejectedValueOnce(new Error("upstream down"));
        const { startReplacementNotificationDispatcher } = await import("../worker.js");

        const timer = startReplacementNotificationDispatcher(fakeBot);
        await vi.advanceTimersByTimeAsync(60 * 1000);

        expect(dispatchPending).toHaveBeenCalledTimes(1);
        clearInterval(timer);
    });
});
