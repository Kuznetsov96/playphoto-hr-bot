import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueStaff = vi.fn();
const findUniqueShift = vi.fn();
const findManyShift = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        staffProfile: { findUnique: (...args: unknown[]) => findUniqueStaff(...args) },
        workShift: {
            findUnique: (...args: unknown[]) => findUniqueShift(...args),
            findMany: (...args: unknown[]) => findManyShift(...args),
        },
    },
}));

const { resolveCanonicalShift } = await import("../canonical-shift-resolver.js");

const input = {
    workShiftId: "work-shift-1",
    requesterStaffId: "staff-1",
    locationId: "location-1",
    shiftDate: new Date("2026-08-15T00:00:00.000Z"),
};

beforeEach(() => {
    findUniqueStaff.mockReset();
    findUniqueShift.mockReset();
    findManyShift.mockReset();
    findUniqueStaff.mockResolvedValue({ awsEmployeePublicId: "emp-uuid" });
});

describe("resolveCanonicalShift", () => {
    it("resolves through the direct work shift link", async () => {
        findUniqueShift.mockResolvedValue({ awsScheduledShiftPublicId: "shift-uuid" });
        await expect(resolveCanonicalShift(input)).resolves.toEqual({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
        expect(findManyShift).not.toHaveBeenCalled();
    });

    it("falls back to employee+location+date when the link was nulled", async () => {
        findUniqueShift.mockResolvedValue({ awsScheduledShiftPublicId: null });
        findManyShift.mockResolvedValue([{ awsScheduledShiftPublicId: "shift-uuid" }]);
        await expect(resolveCanonicalShift({ ...input, workShiftId: null })).resolves.toEqual({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
    });

    it("refuses to guess when the fallback matches more than one shift", async () => {
        findManyShift.mockResolvedValue([
            { awsScheduledShiftPublicId: "shift-a" },
            { awsScheduledShiftPublicId: "shift-b" },
        ]);
        await expect(resolveCanonicalShift({ ...input, workShiftId: null })).resolves.toEqual({
            ok: false,
            reasonCode: "AMBIGUOUS_SHIFT",
        });
    });

    it("reports SHIFT_NOT_MAPPED when nothing matches", async () => {
        findManyShift.mockResolvedValue([]);
        await expect(resolveCanonicalShift({ ...input, workShiftId: null })).resolves.toEqual({
            ok: false,
            reasonCode: "SHIFT_NOT_MAPPED",
        });
    });

    it("reports NO_REQUESTER for admin-initiated requests", async () => {
        await expect(resolveCanonicalShift({ ...input, requesterStaffId: null })).resolves.toEqual({
            ok: false,
            reasonCode: "NO_REQUESTER",
        });
        expect(findUniqueStaff).not.toHaveBeenCalled();
    });

    it("reports EMPLOYEE_NOT_MAPPED when the staff profile has no canonical id", async () => {
        findUniqueStaff.mockResolvedValue({ awsEmployeePublicId: null });
        await expect(resolveCanonicalShift(input)).resolves.toEqual({
            ok: false,
            reasonCode: "EMPLOYEE_NOT_MAPPED",
        });
    });

    it("brackets the correct Kyiv calendar day for late-evening UTC (same Kyiv day)", async () => {
        findUniqueShift.mockResolvedValue({ awsScheduledShiftPublicId: null });
        findManyShift.mockResolvedValue([{ awsScheduledShiftPublicId: "shift-uuid" }]);
        // 2026-08-15T20:30:00.000Z is 23:30 on 2026-08-15 in Kyiv (UTC+3)
        await expect(resolveCanonicalShift({ ...input, workShiftId: null, shiftDate: new Date("2026-08-15T20:30:00.000Z") })).resolves.toEqual({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
        // Verify the query bracketed 2026-08-15 in Kyiv
        expect(findManyShift).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    date: {
                        gte: new Date("2026-08-15T00:00:00.000Z"),
                        lt: new Date("2026-08-16T00:00:00.000Z"),
                    },
                }),
            })
        );
    });

    it("brackets the correct Kyiv calendar day for late-evening UTC (next Kyiv day)", async () => {
        findUniqueShift.mockResolvedValue({ awsScheduledShiftPublicId: null });
        findManyShift.mockResolvedValue([{ awsScheduledShiftPublicId: "shift-uuid" }]);
        // 2026-08-15T21:30:00.000Z is 00:30 on 2026-08-16 in Kyiv (UTC+3)
        await expect(resolveCanonicalShift({ ...input, workShiftId: null, shiftDate: new Date("2026-08-15T21:30:00.000Z") })).resolves.toEqual({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
        // Verify the query bracketed 2026-08-16 in Kyiv
        expect(findManyShift).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    date: {
                        gte: new Date("2026-08-16T00:00:00.000Z"),
                        lt: new Date("2026-08-17T00:00:00.000Z"),
                    },
                }),
            })
        );
    });
});
