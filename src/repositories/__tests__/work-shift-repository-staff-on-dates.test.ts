import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {
        workShift: {
            findMany,
        }
    }
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }
}));

import { workShiftRepository } from "../work-shift-repository.js";

describe("workShiftRepository.findShiftsWithLocationForStaffOnDates", () => {
    beforeEach(() => {
        findMany.mockReset();
        findMany.mockResolvedValue([]);
    });

    it("resolves many (staffId, date) pairs in a single query", async () => {
        await workShiftRepository.findShiftsWithLocationForStaffOnDates([
            { staffId: "staff-1", date: new Date("2026-09-20T00:00:00") },
            { staffId: "staff-2", date: new Date("2026-09-20T00:00:00") },
            { staffId: "staff-3", date: new Date("2026-09-21T00:00:00") },
        ]);

        expect(findMany).toHaveBeenCalledTimes(1);
        const args = findMany.mock.calls[0]![0] as any;
        expect(args.where.OR).toHaveLength(3);
    });

    it("returns an empty list without touching the database when given no pairs", async () => {
        const result = await workShiftRepository.findShiftsWithLocationForStaffOnDates([]);

        expect(result).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("dedupes identical (staffId, calendar day) pairs instead of repeating the OR condition", async () => {
        await workShiftRepository.findShiftsWithLocationForStaffOnDates([
            { staffId: "staff-1", date: new Date("2026-09-20T08:00:00") },
            { staffId: "staff-1", date: new Date("2026-09-20T18:00:00") },
        ]);

        const args = findMany.mock.calls[0]![0] as any;
        expect(args.where.OR).toHaveLength(1);
    });

    it("bounds each condition to the whole local day of its date", async () => {
        await workShiftRepository.findShiftsWithLocationForStaffOnDates([
            { staffId: "staff-1", date: new Date("2026-09-20T13:45:30") },
        ]);

        const args = findMany.mock.calls[0]![0] as any;
        const condition = args.where.OR[0];
        expect(condition.staffId).toBe("staff-1");
        expect(condition.date.gte.getHours()).toBe(0);
        expect(condition.date.lte.getHours()).toBe(23);
    });

    it("includes the shift's location with opening hours, matching the single-pair lookup", async () => {
        await workShiftRepository.findShiftsWithLocationForStaffOnDates([
            { staffId: "staff-1", date: new Date("2026-09-20T00:00:00") },
        ]);

        const args = findMany.mock.calls[0]![0] as any;
        expect(args.include.location.include.openingHours).toBeDefined();
    });
});
