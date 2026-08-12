import { Prisma } from "@prisma/client";
import type { WorkShift } from "@prisma/client";
import prisma from "../db/core.js";

/**
 * `location: true` alone loads only scalars, so the canonical opening hours would come back
 * undefined and every shift without explicit times would read "час не вказано". Anything that
 * renders a shift time must include the relation.
 */
const locationWithOpeningHours = {
    include: { openingHours: { orderBy: { dayOfWeek: "asc" } } },
} satisfies Prisma.LocationDefaultArgs;

export class WorkShiftRepository {
    async findShiftWithLocationOnDate(staffId: string, date: Date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return prisma.workShift.findFirst({
            where: {
                staffId,
                date: { gte: startOfDay, lte: endOfDay }
            },
            include: { location: locationWithOpeningHours },
            orderBy: { date: 'asc' }
        });
    }

    async findByDateRange(start: Date, end: Date): Promise<WorkShift[]> {
        return prisma.workShift.findMany({
            where: {
                date: { gte: start, lt: end }
            }
        });
    }

    async findWithRelationsByDateRange(start: Date, end: Date) {
        return prisma.workShift.findMany({
            where: {
                date: { gte: start, lt: end }
            },
            include: { staff: { include: { user: true } }, location: locationWithOpeningHours }
        });
    }

    async findByLocationAndDateRange(locationId: string, start: Date, end: Date): Promise<WorkShift[]> {
        return prisma.workShift.findMany({
            where: {
                locationId,
                date: { gte: start, lt: end }
            },
            include: { staff: { include: { user: true } } }
        });
    }

    async create(data: Prisma.WorkShiftCreateInput): Promise<WorkShift> {
        return prisma.workShift.create({
            data
        });
    }

    async deleteManyByDateRange(start: Date, end: Date): Promise<Prisma.BatchPayload> {
        return prisma.workShift.deleteMany({
            where: { date: { gte: start, lte: end } }
        });
    }

    async deleteManyForStaffSince(staffId: string, since: Date): Promise<Prisma.BatchPayload> {
        return prisma.workShift.deleteMany({
            where: {
                staffId,
                date: { gte: since }
            }
        });
    }

    async findWithLocationForStaff(staffId: string, since: Date, limit: number = 100) {
        return prisma.workShift.findMany({
            where: {
                staffId,
                date: { gte: since }
            },
            include: { location: locationWithOpeningHours },
            orderBy: { date: 'asc' },
            take: limit
        });
    }

    /**
     * Finds the shift closest to a given date for a staff member.
     * Checks the same calendar day first, then nearest future, then nearest past.
     */
    async findClosestShiftWithLocation(staffId: string, aroundDate: Date) {
        const sameDayShift = await this.findShiftWithLocationOnDate(staffId, aroundDate);
        if (sameDayShift) return sameDayShift;

        // Try nearest future shift next
        const futureShift = await prisma.workShift.findFirst({
            where: { staffId, date: { gte: aroundDate } },
            include: { location: locationWithOpeningHours },
            orderBy: { date: 'asc' }
        });
        if (futureShift) return futureShift;

        // Fallback to most recent past shift
        return prisma.workShift.findFirst({
            where: { staffId, date: { lt: aroundDate } },
            include: { location: locationWithOpeningHours },
            orderBy: { date: 'desc' }
        });
    }

    /**
     * Finds all colleagues working at the same location on the same date.
     * Returns staff names excluding the given staffId.
     */
    async findColleaguesForShift(staffId: string, locationId: string, date: Date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return prisma.workShift.findMany({
            where: {
                locationId,
                date: { gte: startOfDay, lte: endOfDay },
                staffId: { not: staffId }
            },
            include: { staff: { include: { user: true } } }
        });
    }

    /**
     * Batch finds colleagues for multiple shifts.
     */
    async findColleaguesForShifts(staffId: string, shifts: { locationId: string; date: Date }[]) {
        if (shifts.length === 0) return [];

        const conditions = shifts.map(s => {
            const start = new Date(s.date);
            start.setHours(0, 0, 0, 0);
            const end = new Date(s.date);
            end.setHours(23, 59, 59, 999);
            return {
                locationId: s.locationId,
                date: { gte: start, lte: end }
            };
        });

        return prisma.workShift.findMany({
            where: {
                OR: conditions,
                staffId: { not: staffId }
            },
            include: { staff: { include: { user: true } } }
        });
    }

    /**
     * Finds every scheduled photographer for the requested location/date slots.
     * Used to decide whether an accepted replacement is still pending or has
     * been superseded by a later manual schedule update.
     */
    async findForSlots(shifts: { locationId: string; date: Date }[]) {
        if (shifts.length === 0) return [];

        const conditions = shifts.map(shift => {
            const start = new Date(shift.date);
            start.setUTCHours(0, 0, 0, 0);
            const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
            return {
                locationId: shift.locationId,
                date: { gte: start, lt: end }
            };
        });

        return prisma.workShift.findMany({
            where: { OR: conditions }
        });
    }

    async countShiftsForStaff(staffId: string, since: Date): Promise<number> {
        return prisma.workShift.count({
            where: {
                staffId,
                date: { gte: since }
            }
        });
    }

    async countInRange(start: Date, end: Date): Promise<number> {
        return prisma.workShift.count({
            where: {
                date: { gte: start, lte: end }
            }
        });
    }

    async findEarliestShift(staffId: string): Promise<WorkShift | null> {
        return prisma.workShift.findFirst({
            where: { staffId },
            orderBy: { date: 'asc' }
        });
    }
}

export const workShiftRepository = new WorkShiftRepository();
