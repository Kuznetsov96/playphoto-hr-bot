import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastCreate = vi.fn();
const broadcastUpdate = vi.fn();
const broadcastDelete = vi.fn();
const deliveryCreateMany = vi.fn();
const deliveryFindUnique = vi.fn();
const trackedCreate = vi.fn();
const pendingReplyCreate = vi.fn();
const userUpsert = vi.fn();
const queueAdd = vi.fn();
const staffFindActive = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: { findActive: staffFindActive } }));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { create: broadcastCreate, update: broadcastUpdate, delete: broadcastDelete },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: {
        createMany: deliveryCreateMany,
        findUnique: deliveryFindUnique,
        claimPending: vi.fn().mockResolvedValue({ count: 1 }),
        markSent: vi.fn(),
        markSkipped: vi.fn(),
        markFailed: vi.fn(),
        getStats: vi.fn().mockResolvedValue({ SENT: 2 }),
    },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({ trackedMessageRepository: { create: trackedCreate } }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: { create: pendingReplyCreate } }));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: { upsert: userUpsert } }));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: queueAdd } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { missingSchedulePreferences: vi.fn() } }));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 }, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: false }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));

const PUBLIC_ID = "11111111-1111-4111-8111-111111111111";

describe("broadcast to an explicit telegram id list (pm_ids)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        staffFindActive.mockResolvedValue([]);
        broadcastCreate.mockResolvedValue({ id: 42 });
        deliveryCreateMany.mockResolvedValue({ count: 2 });
        deliveryFindUnique.mockResolvedValue({ id: 7, status: "PENDING" });
        trackedCreate.mockResolvedValue({ id: 900 });
        userUpsert.mockResolvedValue({});
        queueAdd.mockResolvedValue({});
    });

    it("resolves ids to user deliveries and ignores non-numeric values", async () => {
        const { broadcastService } = await import("../broadcast.js");
        await expect(broadcastService.resolveTargets({ type: "pm_ids", value: ["100", "x", "200", "100"] }))
            .resolves.toEqual({ chats: [], users: [100n, 200n] });
        expect(staffFindActive).not.toHaveBeenCalled();
    });

    it("createBroadcast stores publicId, origin and author name, and queues the job", async () => {
        const { broadcastService } = await import("../broadcast.js");

        await broadcastService.createBroadcast(
            null, 0, "<b>Hi</b>", { type: "pm_ids", value: ["100", "200"] }, undefined, undefined,
            { buttonType: "default" },
            { publicId: PUBLIC_ID, origin: "WEBAPP", authorName: "Віталій" },
        );

        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({
            initiatorId: 0n, publicId: PUBLIC_ID, origin: "WEBAPP", authorName: "Віталій",
            targetSummary: "👤 Recipients (2)", buttonType: "default",
        }));
        expect(queueAdd).toHaveBeenCalledWith("send-broadcast", expect.objectContaining({ broadcastId: 42 }),
            expect.objectContaining({ jobId: "broadcast-42" }));
    });

    it("removes the webapp row when enqueue fails so a retry can recreate it", async () => {
        queueAdd.mockRejectedValueOnce(new Error("Redis unavailable"));
        broadcastDelete.mockResolvedValue({});
        const { broadcastService } = await import("../broadcast.js");

        await expect(broadcastService.createBroadcast(
            null, 0, "Hi", { type: "pm_ids", value: ["100"] }, undefined, undefined, undefined,
            { publicId: PUBLIC_ID, origin: "WEBAPP" },
        )).rejects.toThrow("Redis unavailable");

        expect(broadcastDelete).toHaveBeenCalledWith(42);
        expect(broadcastUpdate).not.toHaveBeenCalled();
    });

    it("delivers privately: USER deliveries, a TrackedMessage with the reminder schedule, a PendingReply, and a minimal User for an unknown id", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };
        const pingUntil = "2026-11-01T10:00:00.000Z";
        const { broadcastService } = await import("../broadcast.js");
        const before = Date.now();

        await broadcastService.processBroadcast({
            broadcastId: 42,
            messageText: "<b>Hi</b>",
            target: { type: "pm_ids", value: ["100", "200"] },
            botUsername: "pp_bot",
            pingOptions: { buttonType: "default", initialDelayMs: 3_600_000, repeatIntervalMs: 7_200_000, pingUntil },
        }, api);

        expect(deliveryCreateMany).toHaveBeenCalledWith([
            { broadcastId: 42, chatId: 100n, targetType: "USER" },
            { broadcastId: 42, chatId: 200n, targetType: "USER" },
        ]);
        expect(userUpsert).toHaveBeenCalledWith({ where: { telegramId: 100n }, create: { telegramId: 100n }, update: {} });
        expect(userUpsert).toHaveBeenCalledWith({ where: { telegramId: 200n }, create: { telegramId: 200n }, update: {} });
        const tracked = trackedCreate.mock.calls[0]![0];
        expect(tracked.pingIntervalMs).toBe(7_200_000);
        expect(tracked.pingUntil).toBe(pingUntil);
        expect(tracked.nextPingAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(tracked.nextPingAt.getTime()).toBeLessThan(before + 3_600_000 + 5_000);
        expect(pendingReplyCreate).toHaveBeenCalledTimes(2);
        // Личная доставка: «Не згодна» — callback, а не URL группового чата.
        const markup = api.sendMessage.mock.calls[0]![2].reply_markup.inline_keyboard.flat();
        expect(markup.map((b: { callback_data?: string }) => b.callback_data)).toEqual([
            "broadcast_confirm_ok_42", "broadcast_confirm_decline_42",
        ]);
        expect(api.sendMessage.mock.calls[0]![2].parse_mode).toBe("HTML");
    });

    it("without reminders the tracked message never pings", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };
        const { broadcastService } = await import("../broadcast.js");

        await broadcastService.processBroadcast({
            broadcastId: 42, messageText: "Hi",
            target: { type: "pm_ids", value: ["100"] },
            pingOptions: { buttonType: "default", noReminders: true },
        }, api);

        expect(trackedCreate.mock.calls[0]![0].nextPingAt).toBeNull();
    });

    it("a no-button broadcast creates neither TrackedMessage nor PendingReply", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };
        const { broadcastService } = await import("../broadcast.js");

        await broadcastService.processBroadcast({
            broadcastId: 42, messageText: "Hi",
            target: { type: "pm_ids", value: ["100"] },
            pingOptions: { buttonType: "none", noReminders: true },
        }, api);

        expect(trackedCreate).not.toHaveBeenCalled();
        expect(pendingReplyCreate).not.toHaveBeenCalled();
    });
});
