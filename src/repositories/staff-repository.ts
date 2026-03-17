import prisma from "../db/core.js";
import { Prisma } from "@prisma/client";
import type { StaffProfile, User, Location, Task } from "@prisma/client";
import { isFuzzyMatch } from "../utils/string-utils.js";
import logger from "../core/logger.js";

export type StaffWithRelations = StaffProfile & {
    user?: User;
    location?: Location | null;
};

export class StaffRepository {
    async findByUserId(userId: string): Promise<StaffWithRelations | null> {
        return prisma.staffProfile.findUnique({
            where: { userId },
            include: { user: true, location: true }
        }) as unknown as Promise<StaffWithRelations | null>;
    }

    async findAll(): Promise<StaffWithRelations[]> {
        return prisma.staffProfile.findMany({
            include: { user: true, location: true }
        }) as unknown as Promise<StaffWithRelations[]>;
    }

    async findMany(args: Prisma.StaffProfileFindManyArgs): Promise<StaffWithRelations[]> {
        return prisma.staffProfile.findMany({
            ...args,
            include: { user: true, location: true, ...args.include }
        }) as unknown as Promise<StaffWithRelations[]>;
    }

    async findById(id: string): Promise<StaffWithRelations | null> {
        return prisma.staffProfile.findUnique({
            where: { id },
            include: { user: true, location: true }
        }) as unknown as Promise<StaffWithRelations | null>;
    }

    async findActive(): Promise<StaffWithRelations[]> {
        return prisma.staffProfile.findMany({
            where: { isActive: true },
            include: { user: true, location: true }
        }) as unknown as Promise<StaffWithRelations[]>;
    }

    async findByLocation(locationId: string): Promise<StaffProfile[]> {
        return prisma.staffProfile.findMany({
            where: { locationId, isActive: true },
            include: { user: true }
        });
    }

    async findWithShiftAtLocation(locationId: string, date: Date): Promise<StaffProfile[]> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        logger.debug({ 
            locationId, 
            inputDate: date.toISOString(),
            startWindow: startOfDay.toISOString(),
            endWindow: endOfDay.toISOString()
        }, "🔍 findWithShiftAtLocation search parameters");

        const result = await prisma.staffProfile.findMany({
            where: {
                isActive: true,
                shifts: {
                    some: {
                        locationId,
                        date: {
                            gte: startOfDay,
                            lte: endOfDay
                        }
                    }
                }
            },
            include: { user: true }
        });

        logger.debug({ foundCount: result.length }, "🔍 findWithShiftAtLocation search result");
        return result;
    }

    async findManyByIds(ids: string[]): Promise<StaffWithRelations[]> {
        return prisma.staffProfile.findMany({
            where: { id: { in: ids } },
            include: { user: true, location: true }
        }) as unknown as Promise<StaffWithRelations[]>;
    }

    async create(data: Prisma.StaffProfileCreateInput): Promise<StaffProfile> {
        const profile = await prisma.staffProfile.create({
            data,
            include: { user: true }
        });
        
        // Sync access for new hires (ensure they are let in if active)
        if (profile.isActive && profile.user?.telegramId) {
            try {
                const { accessService } = await import("../services/access-service.js");
                await accessService.syncUserAccess(profile.user.telegramId);
            } catch (e) {}
        }

        return profile;
    }

    async update(id: string, data: Prisma.StaffProfileUpdateInput): Promise<StaffProfile> {
        const profile = await prisma.staffProfile.update({
            where: { id },
            data,
            include: { user: true }
        });

        // If isActive status changed, sync channel access
        if (data.isActive !== undefined && profile.user?.telegramId) {
            try {
                const { accessService } = await import("../services/access-service.js");
                await accessService.syncUserAccess(profile.user.telegramId);
            } catch (e) {}
        }

        return profile;
    }

    async delete(id: string): Promise<StaffProfile> {
        return prisma.staffProfile.delete({
            where: { id }
        });
    }

    async deleteRelatedData(staffId: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
            // 1. Delete associated shifts
            await tx.workShift.deleteMany({
                where: { staffId }
            });

            // 2. Delete associated tasks
            await tx.task.deleteMany({
                where: { staffId }
            });

            // 3. Unlink from candidates where this staff is a first shift partner
            await tx.candidate.updateMany({
                where: { firstShiftPartnerId: staffId },
                data: { firstShiftPartnerId: null }
            });

            // 4. Finally delete the profile
            await tx.staffProfile.delete({
                where: { id: staffId }
            });
        });
    }

    async findByQuery(query: string): Promise<StaffProfile[]> {
        // Fetch all active to perform robust fuzzy search in memory (dataset is small ~100)
        const allStaff = await this.findActive();

        if (!query) return allStaff.slice(0, 20);

        const results = allStaff.filter(staff => {
            const nameMatch = isFuzzyMatch(staff.fullName, query);
            const userMatch = staff.user?.username ? isFuzzyMatch(staff.user.username, query) : false;
            return nameMatch || userMatch;
        });

        if (results.length > 0) return results.slice(0, 20);

        // Fallback: Direct DB query if fuzzy search fails (handles weird encoding or specific partial matches)
        return prisma.staffProfile.findMany({
            where: {
                isActive: true,
                OR: [
                    { fullName: { contains: query, mode: 'insensitive' } },
                    { user: { username: { contains: query, mode: 'insensitive' } } }
                ]
            },
            include: { user: true, location: true },
            take: 20
        });
    }

    async countActive(): Promise<number> {
        return prisma.staffProfile.count({
            where: { isActive: true }
        });
    }

    async findInactiveWithUser(): Promise<StaffProfile[]> {
        const activeStaff = await prisma.staffProfile.findMany({
            where: { isActive: true },
            include: { user: true }
        });

        // Return staff where there's no connected user, or the user's telegram ID is essentially empty/0
        return activeStaff.filter(s => !s.user || s.user.telegramId === 0n);
    }

    async findForMorningDigest(start: Date, end: Date) {
        return prisma.staffProfile.findMany({
            where: {
                isActive: true,
                AND: [
                    {
                        OR: [
                            { lastTaskDigestAt: { lt: start } },
                            { lastTaskDigestAt: null },
                        ],
                    },
                    {
                        // Include if has pending tasks OR has a shift today
                        OR: [
                            {
                                tasks: {
                                    some: {
                                        isCompleted: false,
                                        OR: [
                                            { workDate: { gte: start, lte: end } },
                                            { workDate: null },
                                        ],
                                    },
                                },
                            },
                            {
                                shifts: {
                                    some: {
                                        date: { gte: start, lte: end }
                                    }
                                }
                            }
                        ]
                    }
                ]
            },
            include: {
                user: true,
                location: true, // legacy global location
                shifts: {
                    where: {
                        date: { gte: start, lte: end }
                    },
                    include: { location: true }
                },
                tasks: {
                    where: {
                        isCompleted: false,
                        OR: [
                            { workDate: { gte: start, lte: end } },
                            { workDate: null },
                        ],
                    },
                },
            },
        });
    }
}

export const staffRepository = new StaffRepository();
