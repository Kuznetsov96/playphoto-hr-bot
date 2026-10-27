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
const syncSafe = vi.fn();
const pingLogMessages = vi.fn();

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
    },
}));
vi.mock("../../repositories/broadcast-ping-log-repository.js", () => ({
    broadcastPingLogRepository: { findMessages: pingLogMessages },
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
        pingLogMessages.mockResolvedValue([]);
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

        expect(result).toEqual({ deleted: 3, failed: 0, deletedChats: 3, stayed: [] });
        expect(api.deleteMessage).toHaveBeenCalledWith(-100, 11);
        expect(api.deleteMessage).toHaveBeenCalledWith(-200, 22);
        expect(api.deleteMessage).toHaveBeenCalledWith(777, 33);
        expect(api.deleteMessage).toHaveBeenCalledTimes(3);
        expect(broadcastUpdateMany).toHaveBeenCalledWith(
            { id: 5, withdrawnAt: null },
            { withdrawnAt: expect.any(Date), withdrawnByTelegramId: 99n, manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null },
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

        expect(result).toMatchObject({ deleted: 2, failed: 1, deletedChats: 2 });
        expect(result.stayed).toHaveLength(1);
        expect(broadcastUpdateMany).toHaveBeenCalledWith({ id: 5, withdrawnAt: null }, expect.objectContaining({ withdrawnAt: expect.any(Date) }));
    });

    it("is idempotent: a second call deletes nothing", async () => {
        broadcastUpdateMany.mockResolvedValue({ count: 0 });
        const api = { deleteMessage: vi.fn() };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(result).toEqual({ deleted: 0, failed: 0, deletedChats: 0, stayed: [] });
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

        expect(results).toEqual([
            { deleted: 3, failed: 0, deletedChats: 3, stayed: [] },
            { deleted: 0, failed: 0, deletedChats: 0, stayed: [] },
        ]);
        expect(api.deleteMessage).toHaveBeenCalledTimes(3);
    });

    it("deletes parts, the delivery message and the last reminder of a chat; reports stayed chats by id", async () => {
        trackedFindMany.mockResolvedValue([
            { id: 1, chatId: 10n, messageId: 100, lastPingMsgId: 150, pendingReplies: [] },
            { id: 2, chatId: 20n, messageId: 200, lastPingMsgId: null, pendingReplies: [] },
        ]);
        deliveryFindSent.mockResolvedValue([
            { chatId: 10n, messageId: 100, partMessageIds: [100, 101, 102] },
            { chatId: 20n, messageId: 200, partMessageIds: [200, 201] },
            { chatId: 30n, messageId: null, partMessageIds: [300] }, // упала посреди альбома
        ]);
        const api = {
            deleteMessage: vi.fn(async (chatId: number, messageId: number) => {
                if (chatId === 20 && messageId === 201) throw new Error("message can't be deleted");
                return true;
            }),
        };

        const result = await broadcastService.withdrawBroadcast(api, 5, { name: "Olha" });

        expect(api.deleteMessage.mock.calls.map(c => c.join(":")).sort()).toEqual(
            ["10:100", "10:101", "10:102", "10:150", "20:200", "20:201", "30:300"].sort(),
        );
        // Чат «остался», если не ушло хотя бы одно из его сообщений.
        expect(result).toEqual({ deleted: 6, failed: 1, deletedChats: 2, stayed: ["20"] });
        expect(broadcastUpdateMany).toHaveBeenCalledWith(
            { id: 5, withdrawnAt: null },
            expect.objectContaining({ withdrawnByName: "Olha" }),
        );
    });

    it("counts an already-deleted message as gone, not as stayed", async () => {
        trackedFindMany.mockResolvedValue([{ id: 1, chatId: 10n, messageId: 100, pendingReplies: [] }]);
        deliveryFindSent.mockResolvedValue([]);
        const api = { deleteMessage: vi.fn().mockRejectedValue({ description: "Bad Request: message to delete not found" }) };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(result).toMatchObject({ deletedChats: 1, stayed: [] });
    });

    it("deletes every reminder logged for the broadcast, not just the last one (item 16)", async () => {
        trackedFindMany.mockResolvedValue([{ id: 1, chatId: 10n, messageId: 100, lastPingMsgId: 502, pendingReplies: [] }]);
        deliveryFindSent.mockResolvedValue([]);
        pingLogMessages.mockResolvedValue([
            { chatId: 10n, messageId: 500 }, { chatId: 10n, messageId: 501 }, { chatId: 10n, messageId: 502 },
        ]);
        const api = { deleteMessage: vi.fn().mockResolvedValue(true) };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(api.deleteMessage.mock.calls.map(c => c.join(":")).sort()).toEqual(["10:100", "10:500", "10:501", "10:502"]);
        expect(result).toMatchObject({ deleted: 4, failed: 0, deletedChats: 1, stayed: [] });
    });

    it("item 22: 'not found' on a retry means deleted; \"can't be deleted\" still means stayed", async () => {
        broadcastUpdateMany.mockResolvedValue({ count: 0 });
        broadcastUpdate.mockResolvedValue({});
        trackedFindMany.mockResolvedValue([
            { id: 1, chatId: 10n, messageId: 100, pendingReplies: [] },
            { id: 2, chatId: 20n, messageId: 200, pendingReplies: [] },
        ]);
        deliveryFindSent.mockResolvedValue([]);
        const api = {
            deleteMessage: vi.fn(async (c: number) => {
                if (c === 10) throw { description: "Bad Request: message to delete not found" };
                throw { description: "Bad Request: message can't be deleted for everyone" };
            }),
        };

        const result = await broadcastService.withdrawBroadcast(api, 5, { name: "Olha" }, { sweep: true });

        expect(result).toMatchObject({ deletedChats: 1, stayed: ["20"] });
    });

    it("stopPinging by a webapp actor records the name", async () => {
        await broadcastService.stopPinging(5, "Olha");
        expect(broadcastUpdate).toHaveBeenCalledWith(5, expect.objectContaining({ remindersStoppedByName: "Olha" }));
    });

    it("webapp sweep after a crash mid-deletion: claim lost, remaining messages are still deleted and a real result is returned", async () => {
        broadcastUpdateMany.mockResolvedValue({ count: 0 }); // withdrawnAt уже стоит
        broadcastUpdate.mockResolvedValue({});
        trackedFindMany.mockResolvedValue([{ id: 1, chatId: 10n, messageId: 100, lastPingMsgId: null, pendingReplies: [] }]);
        deliveryFindSent.mockResolvedValue([{ chatId: 10n, messageId: 100, partMessageIds: [100, 101] }]);
        const api = {
            deleteMessage: vi.fn(async (_c: number, m: number) => {
                if (m === 100) throw { description: "Bad Request: message to delete not found" }; // ушло до сбоя
                return true;
            }),
        };

        const result = await broadcastService.withdrawBroadcast(api, 5, { name: "Olha" }, { sweep: true });

        expect(api.deleteMessage).toHaveBeenCalledWith(10, 101);
        expect(result).toEqual({ deleted: 2, failed: 0, deletedChats: 1, stayed: [] });
        expect(broadcastUpdate).toHaveBeenCalledWith(5, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
    });

    it("webapp sweep after an admin withdraw reports honestly what stayed", async () => {
        broadcastUpdateMany.mockResolvedValue({ count: 0 });
        broadcastUpdate.mockResolvedValue({});
        trackedFindMany.mockResolvedValue([{ id: 1, chatId: 10n, messageId: 100, pendingReplies: [] }]);
        deliveryFindSent.mockResolvedValue([]);
        const api = { deleteMessage: vi.fn().mockRejectedValue(new Error("message can't be deleted")) };

        const result = await broadcastService.withdrawBroadcast(api, 5, { name: "Olha" }, { sweep: true });

        expect(result).toEqual({ deleted: 0, failed: 1, deletedChats: 0, stayed: ["10"] });
    });

    it("stops pinging before it loads the targets", async () => {
        await broadcastService.withdrawBroadcast({ deleteMessage: vi.fn().mockResolvedValue(true) }, 5, 99);

        expect(trackedUpdateMany).toHaveBeenCalledWith({ broadcastId: 5 }, { nextPingAt: null });
        expect(trackedUpdateMany.mock.invocationCallOrder[0]!).toBeLessThan(trackedFindMany.mock.invocationCallOrder[0]!);
    });

    it("admin path (numeric actor) also deletes partMessageIds", async () => {
        trackedFindMany.mockResolvedValue([]);
        deliveryFindSent.mockResolvedValue([{ chatId: 777n, messageId: 1, partMessageIds: [1, 2, 3] }]);
        const api = { deleteMessage: vi.fn().mockResolvedValue(true) };

        const result = await broadcastService.withdrawBroadcast(api, 5, 99);

        expect(api.deleteMessage.mock.calls.map(c => c[1]).sort()).toEqual([1, 2, 3]);
        expect(result).toMatchObject({ deleted: 3, deletedChats: 1 });
    });

    it("does not export pruneCompletedArchive", () => {
        expect("pruneCompletedArchive" in broadcastService).toBe(false);
    });
});

describe("reminder stops and creation metadata", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        trackedUpdateMany.mockResolvedValue({ count: 4 });
        broadcastCreate.mockResolvedValue({ id: 42 });
        broadcastUpdate.mockResolvedValue({});
        queueAdd.mockResolvedValue({});
    });

    it("stopPinging records remindersStoppedAt", async () => {
        await broadcastService.stopPinging(5);
        expect(broadcastUpdate).toHaveBeenCalledWith(5, { remindersStoppedAt: expect.any(Date), manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
        expect(trackedUpdateMany).toHaveBeenCalledWith({ broadcastId: 5 }, { nextPingAt: null });
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

    it("createBroadcast syncs the announcement only after the job is queued", async () => {
        broadcastCreate.mockResolvedValue({ id: 41 });
        await broadcastService.createBroadcast({}, 1, "text", { type: "hub" });
        expect(syncSafe).toHaveBeenCalledWith(41);
        expect(queueAdd.mock.invocationCallOrder[0]!).toBeLessThan(syncSafe.mock.invocationCallOrder[0]!);
    });

    it("createBroadcast does not sync when queueing fails (webapp row is removed)", async () => {
        broadcastCreate.mockResolvedValue({ id: 42 });
        broadcastDelete.mockResolvedValue({});
        queueAdd.mockRejectedValueOnce(new Error("redis down"));
        await expect(broadcastService.createBroadcast(
            {}, 1, "text", { type: "hub" }, undefined, undefined, undefined, { publicId: "p", origin: "WEBAPP" },
        )).rejects.toThrow("redis down");
        expect(broadcastDelete).toHaveBeenCalledWith(42);
        expect(syncSafe).not.toHaveBeenCalled();
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
