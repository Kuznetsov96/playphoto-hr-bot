import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastUpdate = vi.fn();
const getMediaFileIds = vi.fn();
const deliveryFindUnique = vi.fn();
const markSent = vi.fn();
const markFailed = vi.fn();
const trackedCreate = vi.fn();
const openAttachment = vi.fn();
const getStats = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: { findActive: vi.fn().mockResolvedValue([]) } }));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { update: broadcastUpdate, getMediaFileIds, create: vi.fn() },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
        findUnique: deliveryFindUnique,
        claimPending: vi.fn().mockResolvedValue({ count: 1 }),
        markSent, markSkipped: vi.fn(), markFailed,
        getStats,
    },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({ trackedMessageRepository: { create: trackedCreate } }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: { create: vi.fn() } }));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: { upsert: vi.fn() } }));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: vi.fn() } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { missingSchedulePreferences: vi.fn(), openAnnouncementAttachment: openAttachment },
}));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 }, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: false }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));

const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const photoItem = (id: string) => ({ type: "photo" as const, fileId: "", attachmentPublicId: id, fileName: `${id}.jpg` });

let nextId = 1000;
const makeApi = () => ({
    sendPhoto: vi.fn(async (..._args: any[]) => ({ message_id: nextId++, photo: [{ file_id: "s" }, { file_id: "big" }] })),
    sendMediaGroup: vi.fn(async (_c: number, g: unknown[]) => g.map((_, i) => ({ message_id: nextId++, photo: [{ file_id: `big-${i}` }] }))),
    sendMessage: vi.fn(async (..._args: any[]) => ({ message_id: nextId++ })),
});
const job = (over: Record<string, unknown> = {}) => ({
    broadcastId: 42, messageText: "Привіт", target: { type: "pm_ids", value: ["100", "200"] },
    media: [photoItem(A1)], pingOptions: { buttonType: "default" }, ...over,
});

describe("processBroadcast with webapp attachments", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nextId = 1000;
        getMediaFileIds.mockResolvedValue({});
        broadcastUpdate.mockResolvedValue({});
        getStats.mockResolvedValue({ SENT: 2 });
        markFailed.mockResolvedValue({});
        markSent.mockResolvedValue({});
        deliveryFindUnique.mockResolvedValue({ id: 7, status: "PENDING" });
        trackedCreate.mockResolvedValue({ id: 900 });
        openAttachment.mockImplementation(async () => ({ stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }));
    });

    it("second recipient is sent by file_id; the stream opens once per attachment", async () => {
        const { broadcastService } = await import("../broadcast.js");
        const api = makeApi();
        await broadcastService.processBroadcast(job(), api);

        expect(openAttachment).toHaveBeenCalledTimes(1);
        expect(openAttachment).toHaveBeenCalledWith(A1);
        expect(api.sendPhoto).toHaveBeenCalledTimes(2);
        expect(api.sendPhoto.mock.calls[1]?.[1]).toBe("big");
        expect(broadcastUpdate).toHaveBeenCalledWith(42, { mediaFileIds: { [A1]: "big" } });
        expect(markSent).toHaveBeenCalledTimes(2);
        // сообщение с кнопками отслеживается, части записаны в доставку
        expect(markSent.mock.calls[0]).toEqual([7, 1001, [1000, 1001]]);
        expect(trackedCreate.mock.calls[0]?.[0]).toMatchObject({ messageId: 1001 });
    });

    it("restart with filled mediaFileIds opens no stream", async () => {
        const { broadcastService } = await import("../broadcast.js");
        getMediaFileIds.mockResolvedValue({ [A1]: "cached" });
        const api = makeApi();
        await broadcastService.processBroadcast(job(), api);

        expect(openAttachment).not.toHaveBeenCalled();
        expect(api.sendPhoto.mock.calls.every(c => c[1] === "cached")).toBe(true);
        expect(broadcastUpdate).not.toHaveBeenCalledWith(42, expect.objectContaining({ mediaFileIds: expect.anything() }));
    });

    it("textAsCaption from the job is obeyed: one message with caption and buttons", async () => {
        const { broadcastService } = await import("../broadcast.js");
        const api = makeApi();
        await broadcastService.processBroadcast(job({ textAsCaption: true }), api);

        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(api.sendPhoto.mock.calls[0]?.[2]).toMatchObject({ caption: "Привіт", parse_mode: "HTML" });
        expect((api.sendPhoto.mock.calls[0]?.[2] as { reply_markup?: unknown }).reply_markup).toBeDefined();
    });

    it("failure on the text after an album: FAILED with the album ids, file ids kept, no resend", async () => {
        const { broadcastService } = await import("../broadcast.js");
        const api = makeApi();
        api.sendMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
        getStats.mockResolvedValue({ FAILED: 1 });
        await expect(broadcastService.processBroadcast(
            job({ media: [photoItem(A1), photoItem(A2)], target: { type: "pm_ids", value: ["100"] } }), api,
        )).rejects.toThrow(/incomplete|failed/);

        expect(markSent).not.toHaveBeenCalled();
        expect(markFailed).toHaveBeenCalledTimes(1);
        expect(markFailed.mock.calls[0]?.[0]).toBe(7);
        expect(markFailed.mock.calls[0]?.[2]).toEqual([1000, 1001]);
        expect(broadcastUpdate).toHaveBeenCalledWith(42, { mediaFileIds: { [A1]: "big-0", [A2]: "big-1" } });
        expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    });

    it("a bot admin broadcast with a real fileId keeps the old path", async () => {
        const { broadcastService } = await import("../broadcast.js");
        const api = makeApi();
        await broadcastService.processBroadcast(
            job({ media: { type: "photo", fileId: "REAL" }, target: { type: "pm_ids", value: ["100"] } }), api,
        );

        expect(getMediaFileIds).not.toHaveBeenCalled();
        expect(api.sendPhoto).toHaveBeenCalledWith(100, "REAL");
        expect(markSent).toHaveBeenCalledWith(7, 1001);
    });

    it("TEST with attachments goes through the parts sender without caching file ids", async () => {
        const { broadcastService } = await import("../broadcast.js");
        const api = makeApi();
        const message = await broadcastService.sendTestBroadcast(api, 555, "Hi", [photoItem(A1)], "default", false);

        expect(openAttachment).toHaveBeenCalledWith(A1);
        expect(api.sendPhoto).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(message).toEqual({ message_id: 1001 });
        expect(broadcastUpdate).not.toHaveBeenCalled();
        expect(getMediaFileIds).not.toHaveBeenCalled();
    });
});
