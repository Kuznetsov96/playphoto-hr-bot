import { beforeEach, describe, expect, it, vi } from "vitest";

const staffFindActive = vi.fn();
const broadcastCreate = vi.fn();
const broadcastUpdate = vi.fn();
const deliveryCreateMany = vi.fn();
const deliveryFindUnique = vi.fn();
const deliveryClaimPending = vi.fn();
const deliveryMarkSent = vi.fn();
const deliveryMarkSkipped = vi.fn();
const deliveryMarkFailed = vi.fn();
const deliveryGetStats = vi.fn();
const queueAdd = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: { findActive: staffFindActive },
}));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { create: broadcastCreate, update: broadcastUpdate },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: {
        createMany: deliveryCreateMany,
        findUnique: deliveryFindUnique,
        claimPending: deliveryClaimPending,
        markSent: deliveryMarkSent,
        markSkipped: deliveryMarkSkipped,
        markFailed: deliveryMarkFailed,
        getStats: deliveryGetStats,
    },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: { create: vi.fn() },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { create: vi.fn() },
}));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: queueAdd } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 } }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));

describe("broadcast delivery reliability", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        staffFindActive.mockResolvedValue([]);
        broadcastCreate.mockResolvedValue({ id: 42 });
        broadcastUpdate.mockResolvedValue({});
        deliveryCreateMany.mockResolvedValue({ count: 1 });
        deliveryFindUnique.mockResolvedValue({ id: 7, status: "PENDING" });
        deliveryClaimPending.mockResolvedValue({ count: 1 });
        deliveryMarkSent.mockResolvedValue({});
        deliveryMarkSkipped.mockResolvedValue({});
        deliveryMarkFailed.mockResolvedValue({});
        deliveryGetStats.mockResolvedValue({ SENT: 1 });
        queueAdd.mockResolvedValue({ id: "broadcast-42" });
    });

    it("queues each broadcast with a stable job id and retries", async () => {
        const { broadcastService } = await import("../broadcast.js");

        await broadcastService.createBroadcast(
            {},
            11,
            "Hello",
            { type: "custom_chats", value: ["123"] },
        );

        expect(queueAdd).toHaveBeenCalledWith(
            "send-broadcast",
            expect.objectContaining({ broadcastId: 42 }),
            expect.objectContaining({
                jobId: "broadcast-42",
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
            }),
        );
    });

    it("marks the DB record cancelled when enqueue fails", async () => {
        queueAdd.mockRejectedValueOnce(new Error("Redis unavailable"));
        const { broadcastService } = await import("../broadcast.js");

        await expect(broadcastService.createBroadcast(
            {},
            11,
            "Hello",
            { type: "custom_chats", value: ["123"] },
        )).rejects.toThrow("Redis unavailable");

        expect(broadcastUpdate).toHaveBeenCalledWith(42, { cancelledAt: expect.any(Date) });
    });

    it("persists a successful recipient before completing the broadcast", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };
        const { broadcastService } = await import("../broadcast.js");

        await expect(broadcastService.processBroadcast({
            broadcastId: 42,
            messageText: "Hello",
            target: { type: "custom_chats", value: ["123"] },
            pingOptions: { buttonType: "none" },
        }, api)).resolves.toBe(1);

        expect(deliveryCreateMany).toHaveBeenCalledWith([
            { broadcastId: 42, chatId: 123n, targetType: "GROUP" },
        ]);
        expect(deliveryClaimPending).toHaveBeenCalledWith(7);
        expect(deliveryMarkSent).toHaveBeenCalledWith(7, 99);
        expect(broadcastUpdate).toHaveBeenCalledWith(42, { completedAt: expect.any(Date) });
    });

    it("fails the BullMQ job when a recipient delivery fails", async () => {
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("Telegram unavailable")) };
        deliveryGetStats.mockResolvedValueOnce({ FAILED: 1 });
        const { broadcastService } = await import("../broadcast.js");

        await expect(broadcastService.processBroadcast({
            broadcastId: 42,
            messageText: "Hello",
            target: { type: "custom_chats", value: ["123"] },
            pingOptions: { buttonType: "none" },
        }, api)).rejects.toThrow("1 failed");

        expect(deliveryMarkFailed).toHaveBeenCalledWith(7, expect.any(Error));
        expect(broadcastUpdate).not.toHaveBeenCalledWith(42, { completedAt: expect.any(Date) });
    });

    it("does not duplicate an uncertain send left in SENDING state", async () => {
        deliveryFindUnique.mockResolvedValueOnce({ id: 7, status: "SENDING" });
        deliveryGetStats.mockResolvedValueOnce({ SENDING: 1 });
        const api = { sendMessage: vi.fn() };
        const { broadcastService } = await import("../broadcast.js");

        await expect(broadcastService.processBroadcast({
            broadcastId: 42,
            messageText: "Hello",
            target: { type: "custom_chats", value: ["123"] },
            pingOptions: { buttonType: "none" },
        }, api)).rejects.toThrow("pending or uncertain");

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(deliveryClaimPending).not.toHaveBeenCalled();
    });
});
