import { beforeEach, describe, expect, it, vi } from "vitest";

const hgetall = vi.fn();
const redisDel = vi.fn();
const transactionExec = vi.fn();
const transactionDel = vi.fn();
const transactionHset = vi.fn();
const transactionExpire = vi.fn();
const multi = vi.fn(() => transaction);
const transaction = {
    del: transactionDel,
    hset: transactionHset,
    expire: transactionExpire,
    exec: transactionExec,
};

vi.mock("../redis.js", () => ({
    redis: { hgetall, del: redisDel, multi },
}));

vi.mock("../logger.js", () => ({
    default: {
        trace: vi.fn(),
        error: vi.fn(),
    },
}));

describe("Redis session middleware", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        transactionDel.mockReturnValue(transaction);
        transactionHset.mockReturnValue(transaction);
        transactionExpire.mockReturnValue(transaction);
        transactionExec.mockResolvedValue([[null, 1], [null, 1], [null, 1]]);
    });

    it("atomically replaces the hash so removed fields cannot reappear", async () => {
        hgetall.mockResolvedValue({
            step: JSON.stringify("support_chat"),
            candidateData: JSON.stringify({}),
            supportData: JSON.stringify({ preferredTarget: "HR" }),
        });
        const { lazySession } = await import("../session.js");
        const ctx = {
            from: { id: 12 },
            chat: { id: 34 },
        } as any;

        const middleware = lazySession() as any;
        await middleware(ctx, async () => {
            ctx.session.step = "idle";
            delete ctx.session.supportData;
        });

        expect(transactionDel).toHaveBeenCalledWith("session:34:12");
        expect(transactionHset).toHaveBeenCalledWith(
            "session:34:12",
            expect.not.objectContaining({ supportData: expect.anything() }),
        );
        expect(transactionExpire).toHaveBeenCalledWith("session:34:12", 86400);
        expect(transactionExec).toHaveBeenCalledOnce();
    });

    it("persists mutations before the middleware completes", async () => {
        hgetall.mockResolvedValue({});
        const { lazySession } = await import("../session.js");
        const ctx = { from: { id: 12 }, chat: { id: 34 } } as any;

        const middleware = lazySession() as any;
        await middleware(ctx, async () => {
            ctx.session.step = "booking";
        });

        expect(transactionExec).toHaveBeenCalledOnce();
    });

    it("does not recreate a hash after clearSession deletes it", async () => {
        hgetall.mockResolvedValue({ step: JSON.stringify("support_chat") });
        redisDel.mockResolvedValue(1);
        const { clearSession, lazySession } = await import("../session.js");
        const ctx = { from: { id: 12 }, chat: { id: 34 } } as any;

        const middleware = lazySession() as any;
        await middleware(ctx, async () => {
            await clearSession(ctx);
        });

        expect(redisDel).toHaveBeenCalledWith("session:34:12");
        expect(multi).not.toHaveBeenCalled();
        expect(ctx.session.step).toBe("idle");
    });
});
