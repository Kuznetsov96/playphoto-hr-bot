import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
vi.mock("../../db/core.js", () => ({ default: { pendingReply: { updateMany } } }));

const { pendingReplyRepository } = await import("../pending-reply-repository.js");

describe("recordDeclineReason", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        updateMany.mockResolvedValue({ count: 1 });
    });

    it("caps the reason at 2000 characters", async () => {
        await pendingReplyRepository.recordDeclineReason(1n, 5, "x".repeat(2500));
        const data = updateMany.mock.calls[0]![0].data;
        expect(data.declineReason).toHaveLength(2000);
    });

    it("keeps a short reason intact and targets the declined reply", async () => {
        await pendingReplyRepository.recordDeclineReason(1n, 5, "busy");
        expect(updateMany).toHaveBeenCalledWith({
            where: { userId: 1n, status: "declined", trackedMessage: { broadcastId: 5 } },
            data: { declineReason: "busy" },
        });
    });
});
