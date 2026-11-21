import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bl = vi.hoisted(() => ({ isLoaded: vi.fn(), isBlocked: vi.fn(), ensureLoaded: vi.fn() }));
const securityAudit = vi.hoisted(() => vi.fn());

vi.mock("../../services/telegram-blocklist.js", () => ({ telegramBlocklist: bl }));
vi.mock("../../core/audit-logger.js", () => ({ securityAudit }));

import { telegramBlocklistGate } from "../telegram-blocklist-gate.js";

function makeCtx(update: Record<string, unknown>, from: { id: number } | null = { id: 111 }) {
    return {
        from: from ?? undefined,
        update: { update_id: 1, ...update },
        callbackQuery: update.callback_query,
        reply: vi.fn(),
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
    } as any;
}

describe("telegramBlocklistGate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        bl.isLoaded.mockReturnValue(true);
        bl.isBlocked.mockReturnValue(true);
        bl.ensureLoaded.mockResolvedValue(true);
    });

    it("drops a blocked text message silently with one audit event without text", async () => {
        const ctx = makeCtx({ message: { text: "secret" } });
        const next = vi.fn();
        await telegramBlocklistGate(ctx, next);
        expect(next).not.toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
        expect(securityAudit).toHaveBeenCalledTimes(1);
        const arg = securityAudit.mock.calls[0]![0];
        expect(arg).toMatchObject({
            event: "security.blocked_user_attempt",
            result: "failed",
            telegramId: 111,
            entityType: "bot",
            context: { updateType: "message" },
        });
        expect(JSON.stringify(arg)).not.toContain("secret");
        expect(arg).not.toHaveProperty("text");
    });

    it("answers a blocked callback_query with no arguments", async () => {
        const ctx = makeCtx({ callback_query: { data: "x" } });
        const next = vi.fn();
        await telegramBlocklistGate(ctx, next);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
        expect(next).not.toHaveBeenCalled();
    });

    it("swallows an answerCallbackQuery failure", async () => {
        const ctx = makeCtx({ callback_query: { data: "x" } });
        ctx.answerCallbackQuery.mockRejectedValue(new Error("query is too old"));
        const next = vi.fn();
        await expect(telegramBlocklistGate(ctx, next)).resolves.toBeUndefined();
        expect(next).not.toHaveBeenCalled();
    });

    it("passes a non-blocked user through", async () => {
        bl.isBlocked.mockReturnValue(false);
        const next = vi.fn();
        await telegramBlocklistGate(makeCtx({ message: { text: "hi" } }), next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(securityAudit).not.toHaveBeenCalled();
    });

    it("lets updates through when the list cannot be loaded", async () => {
        bl.isLoaded.mockReturnValue(false);
        bl.ensureLoaded.mockResolvedValue(false);
        const next = vi.fn();
        await telegramBlocklistGate(makeCtx({ message: { text: "hi" } }), next);
        expect(bl.ensureLoaded).toHaveBeenCalledTimes(1);
        expect(bl.isBlocked).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("loads the list lazily and then blocks", async () => {
        bl.isLoaded.mockReturnValue(false);
        const next = vi.fn();
        await telegramBlocklistGate(makeCtx({ message: { text: "hi" } }), next);
        expect(bl.ensureLoaded).toHaveBeenCalledTimes(1);
        expect(next).not.toHaveBeenCalled();
    });

    it("passes updates without from (channel_post)", async () => {
        const next = vi.fn();
        await telegramBlocklistGate(makeCtx({ channel_post: {} }, null), next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(bl.isBlocked).not.toHaveBeenCalled();
    });

    it("is registered in bot.ts before sequentialize, chat logger and recruiting middleware", () => {
        const source = readFileSync(fileURLToPath(new URL("../../core/bot.ts", import.meta.url)), "utf8");
        const gate = source.indexOf("bot.use(telegramBlocklistGate)");
        expect(gate).toBeGreaterThan(-1);
        for (const other of ["bot.use(sequentialize", "bot.use(chatLoggerMiddleware)", "bot.use(recruitingIncomingMiddleware)"]) {
            const idx = source.indexOf(other);
            expect(idx).toBeGreaterThan(-1);
            expect(gate).toBeLessThan(idx);
        }
    });
});
