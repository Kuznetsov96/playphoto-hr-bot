import { beforeEach, describe, expect, it, vi } from "vitest";

const limit = vi.fn((options: any) => async (ctx: any) => options.onLimitExceeded(ctx));

vi.mock("@grammyjs/ratelimiter", () => ({ limit }));
vi.mock("../../config.js", () => ({
    ADMIN_IDS: [100],
    CO_FOUNDER_IDS: [],
    MENTOR_IDS: [],
    SUPPORT_IDS: [],
    HR_IDS: [],
    FINANCE_IDS: [],
    TEAM_CHATS: {},
}));
vi.mock("../../core/logger.js", () => ({
    default: { warn: vi.fn(), debug: vi.fn() },
}));

describe("role-aware rate-limit responses", () => {
    beforeEach(() => vi.clearAllMocks());

    it("answers a candidate callback instead of posting a new chat message", async () => {
        const { createRateLimitMiddleware } = await import("../rate-limit.js");
        const answerCallbackQuery = vi.fn().mockResolvedValue({});
        const reply = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 200 },
            chat: { id: 200 },
            callbackQuery: { data: "button" },
            answerCallbackQuery,
            reply,
        } as any;
        const userRepository = { findWithStaffProfileByTelegramId: vi.fn().mockResolvedValue(null) };

        await createRateLimitMiddleware({}, () => userRepository)(ctx, vi.fn());

        expect(answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
        expect(reply).not.toHaveBeenCalled();
    });

    it("replies to an admin message instead of calling the callback API", async () => {
        const { createRateLimitMiddleware } = await import("../rate-limit.js");
        const answerCallbackQuery = vi.fn();
        const reply = vi.fn().mockResolvedValue({});
        const ctx = {
            from: { id: 100 },
            chat: { id: 100 },
            message: { text: "status" },
            answerCallbackQuery,
            reply,
        } as any;

        await createRateLimitMiddleware({}, () => ({}))(ctx, vi.fn());

        expect(reply).toHaveBeenCalledWith("Too many actions. Slow down a bit.");
        expect(answerCallbackQuery).not.toHaveBeenCalled();
    });
});
