import { beforeEach, describe, expect, it, vi } from "vitest";

const trackedFindFirst = vi.fn();
const pendingFindFirst = vi.fn();
const pendingUpdate = vi.fn();
const syncSafe = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: { findActive: vi.fn().mockResolvedValue([]) } }));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({ broadcastRepository: {} }));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({ broadcastDeliveryRepository: {} }));
vi.mock("../../repositories/tracked-message-repository.js", () => ({ trackedMessageRepository: { findFirst: trackedFindFirst } }));
vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: syncSafe }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { findFirst: pendingFindFirst, update: pendingUpdate },
}));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: vi.fn() } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { missingSchedulePreferences: vi.fn() } }));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 }, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: false }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));

const { broadcastService } = await import("../broadcast.js");

const ctx = () => ({ from: { id: 5 }, chat: { id: 10 }, answerCallbackQuery: vi.fn() }) as never;

describe("confirm transitions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        trackedFindFirst.mockResolvedValue({ id: 1 });
    });

    it("declined -> confirmed is allowed", async () => {
        pendingFindFirst.mockResolvedValue({ id: 9, status: "declined" });
        expect(await broadcastService.confirmRead(ctx(), 7)).toBe("confirmed");
        expect(pendingUpdate).toHaveBeenCalledWith(9, expect.objectContaining({ status: "confirmed" }));
        expect(syncSafe).toHaveBeenCalledWith(7);
    });

    it("confirmed -> declined stays forbidden", async () => {
        pendingFindFirst.mockResolvedValue({ id: 9, status: "confirmed" });
        expect(await broadcastService.confirmDecline(ctx(), 7)).toBe("already_confirmed");
        expect(pendingUpdate).not.toHaveBeenCalled();
    });
});
