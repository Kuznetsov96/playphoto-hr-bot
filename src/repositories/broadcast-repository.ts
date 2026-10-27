import prisma from "../db/core.js";
import type { Prisma } from "@prisma/client";

export class BroadcastRepository {
    async create(data: { initiatorId: bigint; messageText?: string; targetSummary?: string; buttonType?: string; attachmentKinds?: string[]; publicId?: string; origin?: string; authorName?: string }) {
        return prisma.broadcast.create({
            data
        });
    }

    async findByPublicId(publicId: string) {
        return prisma.broadcast.findUnique({ where: { publicId } });
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
