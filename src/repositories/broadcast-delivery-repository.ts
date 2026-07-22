import { Prisma } from "@prisma/client";
import prisma from "../db/core.js";

export class BroadcastDeliveryRepository {
    async createMany(data: Prisma.BroadcastDeliveryCreateManyInput[]) {
        if (data.length === 0) return { count: 0 };
        return prisma.broadcastDelivery.createMany({ data, skipDuplicates: true });
    }

    async findUnique(broadcastId: number, chatId: bigint) {
        return prisma.broadcastDelivery.findUnique({
            where: { broadcastId_chatId: { broadcastId, chatId } },
        });
    }

    async claimPending(id: number) {
        return prisma.broadcastDelivery.updateMany({
            where: { id, status: "PENDING" },
            data: {
                status: "SENDING",
                startedAt: new Date(),
                attemptCount: { increment: 1 },
                lastError: null,
            },
        });
    }

    async markSent(id: number, messageId?: number) {
        return prisma.broadcastDelivery.update({
            where: { id },
            data: {
                status: "SENT",
                ...(messageId !== undefined ? { messageId } : {}),
                sentAt: new Date(),
                lastError: null,
            },
        });
    }

    async markSkipped(id: number, reason: string) {
        return prisma.broadcastDelivery.update({
            where: { id },
            data: { status: "SKIPPED", lastError: reason },
        });
    }

    async markFailed(id: number, error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return prisma.broadcastDelivery.update({
            where: { id },
            data: { status: "FAILED", lastError: message.slice(0, 2000) },
        });
    }

    async getStats(broadcastId: number) {
        const groups = await prisma.broadcastDelivery.groupBy({
            by: ["status"],
            where: { broadcastId },
            _count: { _all: true },
        });
        return Object.fromEntries(groups.map(group => [group.status, group._count._all]));
    }
}

export const broadcastDeliveryRepository = new BroadcastDeliveryRepository();
