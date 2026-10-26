import prisma from "../db/core.js";

export class BroadcastPingLogRepository {
    async create(broadcastId: number, chatId: bigint) {
        return prisma.broadcastPingLog.create({ data: { broadcastId, chatId } });
    }
}

export const broadcastPingLogRepository = new BroadcastPingLogRepository();
