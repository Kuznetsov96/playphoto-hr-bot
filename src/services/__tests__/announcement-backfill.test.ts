import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastFindMany = vi.fn();
const getJob = vi.fn();
const queueAdd = vi.fn();
const warn = vi.fn();
const flag = { enabled: true };

vi.mock("../../db/core.js", () => ({ default: { broadcast: { findMany: broadcastFindMany } } }));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { getJob, add: queueAdd } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: {} }));
vi.mock("../../config.js", () => ({
    TEAM_CHATS: { HUB: -1001 },
    get ANNOUNCEMENTS_SYNC_ENABLED() { return flag.enabled; },
}));

const { enqueueAllAnnouncementSyncs } = await import("../announcement-sync.js");

describe("enqueueAllAnnouncementSyncs", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        flag.enabled = true;
        getJob.mockResolvedValue(null);
    });

    it("enqueues one staggered job per broadcast", async () => {
        broadcastFindMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
        await expect(enqueueAllAnnouncementSyncs()).resolves.toBe(3);
        expect(queueAdd).toHaveBeenCalledTimes(3);
        const delays = queueAdd.mock.calls.map(c => c[2].delay);
        expect(delays[1]).toBeGreaterThan(delays[0]);
        expect(delays[2]).toBeGreaterThan(delays[1]);
        expect(queueAdd.mock.calls.map(c => c[2].jobId)).toEqual([
            "announcement-sync-1", "announcement-sync-2", "announcement-sync-3",
        ]);
    });

    it("pages through all broadcasts by id cursor", async () => {
        const full = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
        broadcastFindMany.mockResolvedValueOnce(full).mockResolvedValueOnce([{ id: 201 }]);
        await expect(enqueueAllAnnouncementSyncs()).resolves.toBe(201);
        expect(broadcastFindMany.mock.calls[1]![0]).toMatchObject({ cursor: { id: 200 }, skip: 1 });
    });

    it("does not duplicate a job that is already waiting", async () => {
        broadcastFindMany.mockResolvedValueOnce([{ id: 1 }]);
        getJob.mockResolvedValue({ getState: async () => "delayed" });
        await expect(enqueueAllAnnouncementSyncs()).resolves.toBe(1);
        expect(queueAdd).not.toHaveBeenCalled();
    });

    it("returns 0 and logs the reason when the flag is off", async () => {
        flag.enabled = false;
        await expect(enqueueAllAnnouncementSyncs()).resolves.toBe(0);
        expect(broadcastFindMany).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("ANNOUNCEMENTS_SYNC_ENABLED");
    });
});
