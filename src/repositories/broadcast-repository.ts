import prisma from "../db/core.js";
import type { Prisma } from "@prisma/client";

export class BroadcastRepository {
    async create(data: { initiatorId: bigint; messageText?: string; targetSummary?: string; buttonType?: string; attachmentKinds?: string[]; publicId?: string; origin?: string; authorName?: string; textAsCaption?: boolean }) {
        return prisma.broadcast.create({
            data
        });
    }

    async findByPublicId(publicId: string) {
        return prisma.broadcast.findUnique({ where: { publicId } });
    }

    /** Накопленные file_id вложений вебаппа: переживают рестарт задачи. */
    async getMediaFileIds(id: number): Promise<Record<string, string>> {
        const row = await prisma.broadcast.findUnique({ where: { id }, select: { mediaFileIds: true } });
        const value = row?.mediaFileIds;
        return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, string>) } : {};
    }

    async delete(id: number) {
        return prisma.broadcast.delete({ where: { id } });
    }

    async findById(id: number) {
        return prisma.broadcast.findUnique({
            where: { id },
            include: { trackedMessages: { include: { pendingReplies: true } } }
        });
    }

    async findRecent(limit: number = 20) {
        return prisma.broadcast.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { trackedMessages: { include: { pendingReplies: true } } }
        });
    }

    /** Отложенные ручные напоминания, чей час настал. */
    async findDueManualReminders(now: Date) {
        return prisma.broadcast.findMany({
            where: { manualRemindAt: { lte: now } },
            select: { id: true, manualRemindActionId: true, withdrawnAt: true, remindersStoppedAt: true },
        });
    }

    async updateMany(where: Prisma.BroadcastWhereInput, data: Prisma.BroadcastUpdateManyMutationInput) {
        return prisma.broadcast.updateMany({ where, data });
    }

    async update(id: number, data: any) {
        return prisma.broadcast.update({
            where: { id },
            data
        });
    }
}

export const broadcastRepository = new BroadcastRepository();
