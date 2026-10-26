import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastCreate = vi.fn();
const broadcastUpdate = vi.fn();
const broadcastUpdateMany = vi.fn();
const broadcastFindById = vi.fn();
const broadcastDelete = vi.fn();
const trackedFindMany = vi.fn();
const trackedUpdateMany = vi.fn();
const pendingDeleteMany = vi.fn();
const deliveryFindSent = vi.fn();
const queueAdd = vi.fn();
const activePingBroadcastIds = vi.fn();
const syncSafe = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: { findActive: vi.fn().mockResolvedValue([]) } }));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: {
        create: broadcastCreate,
        update: broadcastUpdate,
        updateMany: broadcastUpdateMany,
        findById: broadcastFindById,
        delete: broadcastDelete,
    },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: { findSentMessages: deliveryFindSent, getStats: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: {
        findManyWithReplies: trackedFindMany,
        updateMany: trackedUpdateMany,
        findBroadcastIdsWithActivePings: activePingBroadcastIds,
    },
}));
vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: syncSafe }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { deleteMany: pendingDeleteMany },
}));
vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findWithStaffProfileByTelegramId: vi.fn().mockResolvedValue({ firstName: "A" }) },
}));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: queueAdd } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { missingSchedulePreferences: vi.fn() } }));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 }, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: false }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));

const { broadcastService } = await import("../broadcast.js");

describe("withdrawBroadcast", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        broadcastUpdateMany.mockResolvedValue({ count: 1 });
        trackedFindMany.mockResolvedValue([
            { id: 1, chatId: -100n, messageId: 11, pendingReplies: [] },
            { id: 2, chatId: -200n, messageId: 22, pendingReplies: [] },
        ]);
        deliveryFindSent.mockResolvedValue([
            { chatId: -100n, messageId: 11 }, // дубль трекинга
            { chatId: 777n, messageId: 33 }, // личка без трекинга
        ]);
        trackedUpdateMany.mockResolvedValue({ count: 2 });
        broadcastUpdate.mockResolvedValue({});
    });

    it("deletes every tracked message and delivery message, keeps all rows, marks withdrawn", async () => {
        const api = { deleteMessage: vi.fn().mockResolvedValue(true) };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(result).toEqual({ deleted: 3, failed: 0 });
        expect(api.deleteMessage).toHaveBeenCalledWith(-100, 11);
        expect(api.deleteMessage).toHaveBeenCalledWith(-200, 22);
        expect(api.deleteMessage).toHaveBeenCalledWith(777, 33);
        expect(api.deleteMessage).toHaveBeenCalledTimes(3);
        expect(broadcastUpdateMany).toHaveBeenCalledWith(
            { id: 5, withdrawnAt: null },
            { withdrawnAt: expect.any(Date), withdrawnByTelegramId: 99n },
        );
        expect(trackedUpdateMany).toHaveBeenCalledWith({ broadcastId: 5 }, { nextPingAt: null });
        expect(broadcastDelete).not.toHaveBeenCalled();
        expect(pendingDeleteMany).not.toHaveBeenCalled();
    });

    it("counts deleteMessage errors as failed and still marks withdrawn", async () => {
        const api = {
            deleteMessage: vi.fn()
                .mockResolvedValueOnce(true)
                .mockRejectedValueOnce(new Error("message can't be deleted"))
                .mockResolvedValueOnce(true),
        };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(result).toEqual({ deleted: 2, failed: 1 });
        expect(broadcastUpdateMany).toHaveBeenCalledWith({ id: 5, withdrawnAt: null }, expect.objectContaining({ withdrawnAt: expect.any(Date) }));
    });

    it("is idempotent: a second call deletes nothing", async () => {
        broadcastUpdateMany.mockResolvedValue({ count: 0 });
        const api = { deleteMessage: vi.fn() };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(result).toEqual({ deleted: 0, failed: 0 });
        expect(api.deleteMessage).not.toHaveBeenCalled();
        expect(trackedFindMany).not.toHaveBeenCalled();
        expect(syncSafe).not.toHaveBeenCalled();
    });

    it("concurrent calls: only the one that wins the claim deletes messages", async () => {
        broadcastUpdateMany.mockReset();
        broadcastUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
        const api = { deleteMessage: vi.fn().mockResolvedValue(true) };

        const results = await Promise.all([
            broadcastService.withdrawBroadcast(api, 5, 99),
            broadcastService.withdrawBroadcast(api, 5, 98),
        ]);

        expect(results).toEqual([{ deleted: 3, failed: 0 }, { deleted: 0, failed: 0 }]);
        expect(api.deleteMessage).toHaveBeenCalledTimes(3);
    });

    it("does not export pruneCompletedArchive", () => {
        expect("pruneCompletedArchive" in broadcastService).toBe(false);
    });
});

describe("reminder stops and creation metadata", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        trackedUpdateMany.mockResolvedValue({ count: 4 });
        activePingBroadcastIds.mockResolvedValue([3, 8]);
        broadcastCreate.mockResolvedValue({ id: 42 });
        broadcastUpdate.mockResolvedValue({});
        queueAdd.mockResolvedValue({});
    });

    it("stopPinging records remindersStoppedAt", async () => {
        await broadcastService.stopPinging(5);
        expect(broadcastUpdate).toHaveBeenCalledWith(5, { remindersStoppedAt: expect.any(Date) });
        expect(trackedUpdateMany).toHaveBeenCalledWith({ broadcastId: 5 }, { nextPingAt: null });
    });

    it("stopAllPings records remindersStoppedAt on broadcasts with active pings", async () => {
        const count = await broadcastService.stopAllPings();
        expect(count).toBe(4);
        expect(broadcastUpdateMany).toHaveBeenCalledWith(
            { trackedMessages: { some: { nextPingAt: { not: null } } } },
            { remindersStoppedAt: expect.any(Date) },
        );
        // Рассылки запрашиваются ДО обнуления nextPingAt и синкаются все.
        expect(syncSafe).toHaveBeenCalledWith(3);
        expect(syncSafe).toHaveBeenCalledWith(8);
    });

    it("createBroadcast stores button type and attachment kinds", async () => {
        await broadcastService.createBroadcast(
            {}, 1, "text", { type: "hub" },
            [{ type: "photo", fileId: "a" }, { type: "photo", fileId: "b" }, { type: "document", fileId: "c" }] as any,
            "bot", { buttonType: "none" },
        );
        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({
            buttonType: "none",
            attachmentKinds: ["photo", "photo", "document"],
        }));
    });

    it("createBroadcast defaults button type to 'default' and no attachments", async () => {
        await broadcastService.createBroadcast({}, 1, "text", { type: "hub" });
        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({
            buttonType: "default",
            attachmentKinds: [],
        }));
    });
});

describe("'dropped' replies behave like deleted rows", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        broadcastFindById.mockResolvedValue({ id: 5, withdrawnAt: null });
        trackedFindMany.mockResolvedValue([
            {
                id: 1, chatId: 1n, messageId: 1,
                pendingReplies: [
                    { userId: 1n, status: "pending" },
                    { userId: 2n, status: "confirmed" },
                    { userId: 3n, status: "declined" },
                    { userId: 4n, status: "dropped" },
                ],
            },
        ]);
    });

    it("getStats counts only pending/confirmed/declined", async () => {
        const stats = await broadcastService.getStats(5);
        expect([stats.pending, stats.confirmed, stats.declined]).toEqual([1, 1, 1]);
    });

    it("getFullStatusReport lists no dropped user anywhere", async () => {
        const report = await broadcastService.getFullStatusReport(5);
        expect(report.pending).toHaveLength(1);
        expect(report.confirmed).toHaveLength(1);
        expect(report.declined).toHaveLength(1);
    });
});
