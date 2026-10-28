import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const updateMany = vi.fn().mockResolvedValue({ count: 3 });
const deleteMany = vi.fn();

vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { updateMany, deleteMany },
}));
vi.mock("../aws-business-sync.js", () => ({ awsBusinessSyncService: {} }));

const { scheduleSyncService } = await import("../schedule-sync.js");

describe("schedule sync keeps PendingReply history", () => {
    it("marks obsolete preference reminders 'dropped' instead of deleting", async () => {
        const date = new Date(2026, 10, 5);
        const count = await (scheduleSyncService as any).clearObsoletePreferenceRemindersForScheduledStaff(
            [{ staffId: "s1", locationId: "l1", date }],
            [{ telegramId: 10n, staffProfile: { id: "s1" } }],
            date,
            true,
        );

        expect(count).toBe(3);
        expect(deleteMany).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ userId: { in: [10n] }, status: "pending" }),
            { status: "dropped" },
        );
    });

    // Путь внутри syncTeam (~500 строк, Sheets, десяток репозиториев) с моками не вызвать: проверяем исходник.
    it("the inactive-staff path in team sync no longer deletes either", () => {
        const source = readFileSync(new URL("../schedule-sync.ts", import.meta.url), "utf8");
        expect(source).not.toMatch(/pendingReplyRepository\.deleteMany/);
        expect(source).toMatch(/status: "pending",\s*\}, \{ status: "dropped" \}\)/);
    });
});
