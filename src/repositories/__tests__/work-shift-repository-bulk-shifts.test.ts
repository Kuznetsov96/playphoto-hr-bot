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

describe("workShiftRepository.findWithShiftAtLocations", () => {
    beforeEach(() => {
        findMany.mockReset();
        findMany.mockResolvedValue([]);
    });

    it("queries every requested location in a single call", async () => {
        await workShiftRepository.findWithShiftAtLocations(["loc-a", "loc-b", "loc-c"], new Date("2026-09-20T10:00:00"));

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                locationId: { in: ["loc-a", "loc-b", "loc-c"] },
            }),
        }));
    });

    it("excludes deactivated staff, even if they still hold a future shift row", async () => {
        await workShiftRepository.findWithShiftAtLocations(["loc-a"], new Date("2026-09-20T10:00:00"));

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                staff: { isActive: true },
            }),
        }));
    });

    it("includes staff (with user) and location so callers can group and notify without extra queries", async () => {
        await workShiftRepository.findWithShiftAtLocations(["loc-a"], new Date("2026-09-20T10:00:00"));

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            include: expect.objectContaining({
                staff: expect.objectContaining({ include: { user: true } }),
                location: true,
            }),
        }));
    });

    it("bounds the search to the whole local day of the given date", async () => {
        await workShiftRepository.findWithShiftAtLocations(["loc-a"], new Date("2026-09-20T13:45:30"));

        const args = findMany.mock.calls[0]![0] as any;
        const range = args.where.date;

        expect(range.gte.getHours()).toBe(0);
        expect(range.gte.getMinutes()).toBe(0);
        expect(range.gte.getDate()).toBe(20);
        expect(range.lte.getHours()).toBe(23);
        expect(range.lte.getMinutes()).toBe(59);
        expect(range.lte.getDate()).toBe(20);
    });

    it("returns an empty list without touching the database when no locations are given", async () => {
        const result = await workShiftRepository.findWithShiftAtLocations([], new Date("2026-09-20T10:00:00"));

        expect(result).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("returns rows carrying the shift's own location, not the staff member's home location", async () => {
        findMany.mockResolvedValue([
            {
                id: "shift-1",
                staffId: "staff-1",
                locationId: "loc-obolon",
                date: new Date("2026-09-20T10:00:00"),
                staff: {
                    id: "staff-1",
                    fullName: "Photographer With Home Elsewhere",
                    locationId: "loc-podil", // home location, must NOT be what's returned as the shift's location
                    user: { telegramId: BigInt(555) },
                },
                location: { id: "loc-obolon", city: "Kyiv", name: "Obolon" },
            },
        ]);

        const result = await workShiftRepository.findWithShiftAtLocations(["loc-obolon"], new Date("2026-09-20T10:00:00"));

        expect(result).toHaveLength(1);
        expect(result[0]!.location).toEqual({ id: "loc-obolon", city: "Kyiv", name: "Obolon" });
        expect(result[0]!.staff.id).toBe("staff-1");
        // The staff member's home location must play no part in what location this row reports.
        expect(result[0]!.location.id).not.toBe(result[0]!.staff.locationId);
    });
});
