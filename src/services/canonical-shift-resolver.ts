import prisma from "../db/core.js";
import { kyivStartOfDay, nextKyivDay } from "./kyiv-date.js";

export type CanonicalShiftResolveReason =
    | "EMPLOYEE_NOT_MAPPED"
    | "SHIFT_NOT_MAPPED"
    | "AMBIGUOUS_SHIFT"
    | "NO_REQUESTER";

export type CanonicalShiftResolution =
    | { ok: true; scheduledShiftPublicId: string; employeePublicId: string }
    | { ok: false; reasonCode: CanonicalShiftResolveReason };

export interface CanonicalShiftResolveInput {
    workShiftId: string | null;
    requesterStaffId: string | null;
    locationId: string;
    shiftDate: Date;
}

export async function resolveCanonicalShift(
    input: CanonicalShiftResolveInput,
): Promise<CanonicalShiftResolution> {
    if (!input.requesterStaffId) return { ok: false, reasonCode: "NO_REQUESTER" };

    const staff = await prisma.staffProfile.findUnique({
        where: { id: input.requesterStaffId },
        select: { awsEmployeePublicId: true },
    });
    if (!staff?.awsEmployeePublicId) return { ok: false, reasonCode: "EMPLOYEE_NOT_MAPPED" };
    const employeePublicId = staff.awsEmployeePublicId;

    if (input.workShiftId) {
        const shift = await prisma.workShift.findUnique({
            where: { id: input.workShiftId },
            select: { awsScheduledShiftPublicId: true },
        });
        if (shift?.awsScheduledShiftPublicId) {
            return {
                ok: true,
                scheduledShiftPublicId: shift.awsScheduledShiftPublicId,
                employeePublicId,
            };
        }
    }

    const candidates = await prisma.workShift.findMany({
        where: {
            staffId: input.requesterStaffId,
            locationId: input.locationId,
            date: { gte: kyivStartOfDay(input.shiftDate), lt: nextKyivDay(input.shiftDate) },
            awsScheduledShiftPublicId: { not: null },
        },
        select: { awsScheduledShiftPublicId: true },
    });

    if (candidates.length === 0) return { ok: false, reasonCode: "SHIFT_NOT_MAPPED" };
    if (candidates.length > 1) return { ok: false, reasonCode: "AMBIGUOUS_SHIFT" };
    return {
        ok: true,
        scheduledShiftPublicId: candidates[0]!.awsScheduledShiftPublicId!,
        employeePublicId,
    };
}

