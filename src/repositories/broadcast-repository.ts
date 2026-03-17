import prisma from "../db/core.js";

export class BroadcastRepository {
    async create(data: { initiatorId: bigint; messageText?: string; targetSummary?: string }) {
        return prisma.broadcast.create({
            data
        });
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

    async delete(id: number) {
        return prisma.broadcast.delete({
            where: { id }
        });
    }

    async update(id: number, data: any) {
        return prisma.broadcast.update({
            where: { id },
            data
        });
    }
}

export const broadcastRepository = new BroadcastRepository();
