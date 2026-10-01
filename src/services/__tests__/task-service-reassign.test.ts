import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
vi.mock("../../db/core.js", () => ({ default: { task: { updateMany: (...a: unknown[]) => updateMany(...a) } } }));
vi.mock("../../repositories/task-repository.js", () => ({ taskRepository: {} }));
vi.mock("../../repositories/work-shift-repository.js", () => ({ workShiftRepository: {} }));
vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: {} }));

const { taskService } = await import("../task-service.js");

beforeEach(() => updateMany.mockReset().mockResolvedValue({ count: 2 }));

// 01.10.2026: задачі зміни лишались на тій, що віддала зміну, — дайджест і
// ескалації йшли їй, а та, що вийшла, не отримувала нічого.
describe("reassignShiftTasks", () => {
    it("moves only the open tasks of that person, that day and that location", async () => {
        const moved = await taskService.reassignShiftTasks({
            fromStaffId: "staff-1",
            toStaffId: "staff-2",
            shiftDate: new Date("2026-09-30T00:00:00.000Z"),
            city: "Lviv",
            locationName: "Dragon Park 2",
        });

        expect(moved).toBe(2);
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                staffId: "staff-1",
                isCompleted: false,
                workDate: { gte: new Date("2026-09-30T00:00:00.000Z"), lt: new Date("2026-10-01T00:00:00.000Z") },
                city: "Lviv",
                locationName: "Dragon Park 2",
            },
            // Нагадування нова відповідальна ще не отримувала — лічильники з нуля.
            data: { staffId: "staff-2", reminderSentAt: null, overdueAdminNotifiedAt: null },
        });
    });
});
