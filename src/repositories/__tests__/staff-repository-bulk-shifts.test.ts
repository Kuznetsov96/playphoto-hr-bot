import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {
        staffProfile: {
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

import { staffRepository } from "../staff-repository.js";

describe("staffRepository.findWithShiftAtLocations", () => {
    beforeEach(() => {
        findMany.mockReset();
        findMany.mockResolvedValue([]);
    });

    it("queries every requested location in a single call", async () => {
        await staffRepository.findWithShiftAtLocations(["loc-a", "loc-b", "loc-c"], new Date("2026-09-20T10:00:00"));

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                isActive: true,
                shifts: {
                    some: expect.objectContaining({
                        locationId: { in: ["loc-a", "loc-b", "loc-c"] },
                    }),
                },
            }),
        }));
    });

    it("includes user and location so callers can group and notify without extra queries", async () => {
        await staffRepository.findWithShiftAtLocations(["loc-a"], new Date("2026-09-20T10:00:00"));

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            include: { user: true, location: true },
        }));
    });

    it("bounds the search to the whole local day of the given date", async () => {
        await staffRepository.findWithShiftAtLocations(["loc-a"], new Date("2026-09-20T13:45:30"));

        const args = findMany.mock.calls[0]![0] as any;
        const range = args.where.shifts.some.date;

        expect(range.gte.getHours()).toBe(0);
        expect(range.gte.getMinutes()).toBe(0);
        expect(range.gte.getDate()).toBe(20);
        expect(range.lte.getHours()).toBe(23);
        expect(range.lte.getMinutes()).toBe(59);
        expect(range.lte.getDate()).toBe(20);
    });

    it("returns an empty list without touching the database when no locations are given", async () => {
        const result = await staffRepository.findWithShiftAtLocations([], new Date("2026-09-20T10:00:00"));

        expect(result).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });
});
