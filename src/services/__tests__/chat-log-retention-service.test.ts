import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteExpired = vi.fn();
const redisGet = vi.fn();
const redisSet = vi.fn();
const logBusinessEvent = vi.fn();

vi.mock("../../repositories/chat-log-repository.js", () => ({
    chatLogRepository: {
        deleteExpired,
    }
}));

vi.mock("../../core/redis.js", () => ({
    redis: {
        get: (...args: unknown[]) => redisGet(...args),
        set: (...args: unknown[]) => redisSet(...args),
    }
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }
}));

vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: (...args: unknown[]) => logBusinessEvent(...args),
}));

const { ChatLogRetentionService } = await import("../chat-log-retention-service.js");

describe("ChatLogRetentionService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisGet.mockResolvedValue(null);
        redisSet.mockResolvedValue("OK");
        deleteExpired.mockResolvedValue(42);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("deletes with a 180-day age cutoff and a 3-year former-staff cutoff", async () => {
        const now = new Date("2026-07-25T10:00:00Z");
        vi.useFakeTimers();
        vi.setSystemTime(now);

        await ChatLogRetentionService.cleanup();

        expect(deleteExpired).toHaveBeenCalledTimes(1);
        const [ageCutoff, deactivatedCutoff] = deleteExpired.mock.calls[0]!;
        const expectedAge = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
        expect(ageCutoff).toEqual(expectedAge);
        expect((deactivatedCutoff as Date).getFullYear()).toBe(2023);
        expect(redisSet).toHaveBeenCalled();
    });

    it("skips when already triggered today", async () => {
        redisGet.mockResolvedValue("true");

        await ChatLogRetentionService.cleanup();

        expect(deleteExpired).not.toHaveBeenCalled();
        expect(redisSet).not.toHaveBeenCalled();
    });

    it("reports failure and does not mark the day as done when delete throws", async () => {
        deleteExpired.mockRejectedValue(new Error("db down"));

        await ChatLogRetentionService.cleanup();

        expect(redisSet).not.toHaveBeenCalled();
        const failedEvent = logBusinessEvent.mock.calls.find(
            (call) => (call[0] as { result?: string }).result === "failed"
        );
        expect(failedEvent).toBeTruthy();
    });
});
