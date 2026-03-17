import prisma from "../db/core.js";
import { Prisma } from "@prisma/client";

export class TrackedMessageRepository {
    async create(data: Prisma.TrackedMessageCreateInput) {
        return prisma.trackedMessage.create({ data });
    }

    async findFirst(where: Prisma.TrackedMessageWhereInput) {
        return prisma.trackedMessage.findFirst({ where });
    }

    async updateMany(where: Prisma.TrackedMessageWhereInput, data: Prisma.TrackedMessageUpdateManyMutationInput) {
        return prisma.trackedMessage.updateMany({ where, data });
    }

    async deleteMany(where: Prisma.TrackedMessageWhereInput) {
        return prisma.trackedMessage.deleteMany({ where });
    }

    async findManyWithReplies(broadcastId: number) {
        return prisma.trackedMessage.findMany({
            where: { broadcastId },
            include: { pendingReplies: true }
        });
    }

    async findToPing(now: Date) {
        return prisma.trackedMessage.findMany({
            where: {
                nextPingAt: { lte: now }
            },
            include: {
                broadcast: true,
                pendingReplies: {
                    where: { status: "pending" },
                    include: { user: true }
                }
            }
        });
    }

    async update(id: number, data: Prisma.TrackedMessageUpdateInput) {
        return prisma.trackedMessage.update({
            where: { id },
            data
        });
    }

    async stopTracking(id: number) {
        return prisma.trackedMessage.update({
            where: { id },
            data: { nextPingAt: null }
        });
    }
}

export const trackedMessageRepository = new TrackedMessageRepository();
