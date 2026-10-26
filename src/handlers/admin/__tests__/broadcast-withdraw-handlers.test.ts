import { beforeEach, describe, expect, it, vi } from "vitest";

const withdrawBroadcast = vi.fn();
const getStats = vi.fn();
const renderScreen = vi.fn();
const goBack = vi.fn();

vi.mock("../../../services/broadcast.js", () => ({ broadcastService: { withdrawBroadcast, getStats } }));
vi.mock("../../../repositories/location-repository.js", () => ({ locationRepository: {} }));
vi.mock("../../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen, goBack } }));

const { handleWithdrawExec, handleWithdrawCancel } = await import("../broadcast.js");

function makeCtx() {
    return { api: {}, from: { id: 99 }, answerCallbackQuery: vi.fn().mockResolvedValue(true), session: {} } as any;
}
const stats = (attachmentCount: number) => ({
    totalChats: 1, pending: 0, confirmed: 0, declined: 0, deliveryTotal: 1, deliverySent: 1,
    deliveryFailed: 0, deliveryUncertain: 0, deliverySkipped: 0, withdrawnAt: new Date(), attachmentCount,
});

describe("withdraw handlers read the id from callback data", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        withdrawBroadcast.mockResolvedValue({ deleted: 2, failed: 1 });
    });

    it("exec withdraws the given broadcast without touching the session", async () => {
        getStats.mockResolvedValue(stats(1));
        const ctx = makeCtx();
        await handleWithdrawExec(ctx, 17);
        expect(withdrawBroadcast).toHaveBeenCalledWith(ctx.api, 17, 99);
        expect(renderScreen).toHaveBeenCalledTimes(1);
        const text = renderScreen.mock.calls[0]![1] as string;
        expect(text).toContain("Removed: 2");
        expect(text).not.toContain("Album photos");
    });

    it("exec adds the album note when the broadcast has several attachments", async () => {
        getStats.mockResolvedValue(stats(3));
        await handleWithdrawExec(makeCtx(), 17);
        expect(renderScreen.mock.calls[0]![1]).toContain("Album photos sent before this update may stay in chats.");
    });

    it("exec with a bad id does nothing", async () => {
        const ctx = makeCtx();
        await handleWithdrawExec(ctx, NaN);
        expect(withdrawBroadcast).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Session expired.");
    });

    it("cancel returns to the stats of the given broadcast", async () => {
        getStats.mockResolvedValue(stats(1));
        await handleWithdrawCancel(makeCtx(), 17);
        expect(getStats).toHaveBeenCalledWith(17);
        expect(renderScreen).toHaveBeenCalledTimes(1);
        expect(withdrawBroadcast).not.toHaveBeenCalled();
    });

    it("cancel with a bad id goes back", async () => {
        await handleWithdrawCancel(makeCtx(), 0);
        expect(goBack).toHaveBeenCalledTimes(1);
        expect(getStats).not.toHaveBeenCalled();
    });
});
