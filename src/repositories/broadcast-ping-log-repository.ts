import prisma from "../db/core.js";

export class BroadcastPingLogRepository {
    async create(broadcastId: number, chatId: bigint, extra: { messageId?: number; actorName?: string | null } = {}) {
        return prisma.broadcastPingLog.create({
            data: {
                broadcastId,
                chatId,
                ...(extra.messageId !== undefined ? { messageId: extra.messageId } : {}),
                ...(extra.actorName ? { actorName: extra.actorName.slice(0, 300) } : {}),
            },
        });
    }

    /** Все отправленные напоминания рассылки: отзыв удаляет каждое, а не только последнее. */
    async findMessages(broadcastId: number): Promise<{ chatId: bigint; messageId: number }[]> {
        const rows = await prisma.broadcastPingLog.findMany({
            where: { broadcastId, messageId: { not: null } },
            select: { chatId: true, messageId: true },
        });
        return rows.flatMap(r => (r.messageId === null ? [] : [{ chatId: r.chatId, messageId: r.messageId }]));
    }
}

export const broadcastPingLogRepository = new BroadcastPingLogRepository();
