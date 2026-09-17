import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByDateRange, findShiftsWithLocationForStaffOnDates, findById } = vi.hoisted(() => ({
    findByDateRange: vi.fn(),
    findShiftsWithLocationForStaffOnDates: vi.fn(),
    findById: vi.fn(),
}));

vi.mock("../../repositories/task-repository.js", () => ({
    taskRepository: { findByDateRange },
}));

vi.mock("../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findShiftsWithLocationForStaffOnDates },
}));

vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: { findById },
}));

import { taskService } from "../task-service.js";

const WORK_DATE = new Date("2026-09-20T00:00:00");

function makeTask(overrides: Record<string, any> = {}) {
    return {
        id: overrides.id ?? "task-1",
        staffId: overrides.staffId ?? "staff-1",
        workDate: overrides.workDate === undefined ? WORK_DATE : overrides.workDate,
        city: overrides.city ?? null,
        locationName: overrides.locationName ?? null,
        staff: {
            id: overrides.staffId ?? "staff-1",
            location: overrides.homeLocation ?? null,
        },
        ...overrides,
    };
}

function makeShift(staffId: string, date: Date, location: { city: string; name: string }) {
    return { staffId, date, location };
}

describe("taskService.getTasksForDate — bulk shift resolution", () => {
    beforeEach(() => {
        findByDateRange.mockReset();
        findShiftsWithLocationForStaffOnDates.mockReset();
        findById.mockReset();
        findShiftsWithLocationForStaffOnDates.mockResolvedValue([]);
        findById.mockResolvedValue(null);
    });

    it("resolves 30 tasks with a single shift query, not one per task", async () => {
        const tasks = Array.from({ length: 30 }, (_, i) =>
            makeTask({ id: `task-${i}`, staffId: `staff-${i}` }),
        );
        findByDateRange.mockResolvedValue(tasks);
        findShiftsWithLocationForStaffOnDates.mockResolvedValue(
            tasks.map((t) => makeShift(t.staffId, WORK_DATE, { city: "Kyiv", name: "Obolon" })),
        );

        const result = await taskService.getTasksForDate(WORK_DATE);

        expect(findShiftsWithLocationForStaffOnDates).toHaveBeenCalledTimes(1);
        expect(findById).not.toHaveBeenCalled();
        expect(result).toHaveLength(30);
        expect(result.every((t) => t.city === "Kyiv" && t.locationName === "Obolon")).toBe(true);
    });

    it("does not query shifts at all when there are no tasks", async () => {
        findByDateRange.mockResolvedValue([]);

        const result = await taskService.getTasksForDate(WORK_DATE);

        expect(findShiftsWithLocationForStaffOnDates).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it("does not query shifts for tasks with a null workDate", async () => {
        const tasks = [makeTask({ id: "t1", workDate: null, homeLocation: { city: "Lviv", name: "Podil" } })];
        findByDateRange.mockResolvedValue(tasks);

        const result = await taskService.getTasksForDate(WORK_DATE);

        expect(findShiftsWithLocationForStaffOnDates).not.toHaveBeenCalled();
        expect(result[0]!.city).toBe("Lviv");
        expect(result[0]!.locationName).toBe("Podil");
    });

    describe("priority: shift > explicit fallback > staff home location", () => {
        it("prefers the shift location over the task's own city/locationName", async () => {
            const task = makeTask({
                staffId: "staff-1",
                city: "FallbackCity",
                locationName: "FallbackLocation",
                homeLocation: { city: "HomeCity", name: "HomeLocation" },
            });
            findByDateRange.mockResolvedValue([task]);
            findShiftsWithLocationForStaffOnDates.mockResolvedValue([
                makeShift("staff-1", WORK_DATE, { city: "ShiftCity", name: "ShiftLocation" }),
            ]);

            const result = await taskService.getTasksForDate(WORK_DATE);

            expect(result[0]!.city).toBe("ShiftCity");
            expect(result[0]!.locationName).toBe("ShiftLocation");
        });

        it("falls back to the task's explicit city/locationName when no shift exists", async () => {
            const task = makeTask({
                staffId: "staff-1",
                city: "FallbackCity",
                locationName: "FallbackLocation",
                homeLocation: { city: "HomeCity", name: "HomeLocation" },
            });
            findByDateRange.mockResolvedValue([task]);
            findShiftsWithLocationForStaffOnDates.mockResolvedValue([]);

            const result = await taskService.getTasksForDate(WORK_DATE);

            expect(result[0]!.city).toBe("FallbackCity");
            expect(result[0]!.locationName).toBe("FallbackLocation");
        });

        it("falls back to the staff member's home location (from the already-loaded include, no extra query) when neither shift nor explicit fallback exists", async () => {
            const task = makeTask({
                staffId: "staff-1",
                city: null,
                locationName: null,
                homeLocation: { city: "HomeCity", name: "HomeLocation" },
            });
            findByDateRange.mockResolvedValue([task]);
            findShiftsWithLocationForStaffOnDates.mockResolvedValue([]);

            const result = await taskService.getTasksForDate(WORK_DATE);

            expect(result[0]!.city).toBe("HomeCity");
            expect(result[0]!.locationName).toBe("HomeLocation");
            // Home location came from task.staff.location (already included by taskRepository),
            // never from a fresh staffRepository.findById lookup.
            expect(findById).not.toHaveBeenCalled();
        });

        it("returns nulls when there is no shift, no fallback, and no home location", async () => {
            const task = makeTask({ staffId: "staff-1", city: null, locationName: null, homeLocation: null });
            findByDateRange.mockResolvedValue([task]);
            findShiftsWithLocationForStaffOnDates.mockResolvedValue([]);

            const result = await taskService.getTasksForDate(WORK_DATE);

            expect(result[0]!.city).toBeNull();
            expect(result[0]!.locationName).toBeNull();
        });

        it("matches shifts per task by both staffId and calendar day, not just staffId", async () => {
            const otherDay = new Date("2026-09-21T00:00:00");
            const taskA = makeTask({ id: "a", staffId: "staff-1", workDate: WORK_DATE });
            const taskB = makeTask({ id: "b", staffId: "staff-1", workDate: otherDay, homeLocation: { city: "Home", name: "HomeLoc" } });
            findByDateRange.mockResolvedValue([taskA, taskB]);
            // Only a shift for staff-1 on WORK_DATE, none for otherDay.
            findShiftsWithLocationForStaffOnDates.mockResolvedValue([
                makeShift("staff-1", WORK_DATE, { city: "ShiftCity", name: "ShiftLoc" }),
            ]);

            const result = await taskService.getTasksForDate(WORK_DATE);

            const resolvedA = result.find((t) => t.id === "a")!;
            const resolvedB = result.find((t) => t.id === "b")!;
            expect(resolvedA.city).toBe("ShiftCity");
            expect(resolvedB.city).toBe("Home");
        });
    });
});
