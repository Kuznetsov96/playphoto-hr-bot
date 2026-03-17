import prisma from "../db/core.js";

export class ChatLogRepository {
    async logIncoming(
        telegramId: bigint,
        contentType: string,
        text?: string | null,
        mediaFileId?: string | null,
        userId?: string | null
    ) {
        return prisma.chatLog.create({
            data: {
                telegramId,
                userId: userId ?? null,
                direction: "IN",
                contentType,
                text: text ?? null,
                mediaFileId: mediaFileId ?? null,
            }
        }).catch(() => {}); // never block bot on logging failure
    }

    async logOutgoing(
        telegramId: bigint,
        text?: string | null,
        userId?: string | null,
        error?: string | null
    ) {
        let finalItems = text ?? null;
        if (error) {
            finalItems = `❌ [API ERROR]: ${error}${text ? `\n\nOriginal text: ${text}` : ''}`;
        }

        return prisma.chatLog.create({
            data: {
                telegramId,
                userId: userId ?? null,
                direction: "OUT",
                contentType: error ? "error" : "text",
                text: finalItems,
            }
        }).catch(() => {});
    }

    async getHistory(telegramId: bigint, limit = 50, offset = 0) {
        return prisma.chatLog.findMany({
            where: { telegramId },
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
        });
    }

    async getHistoryByUserId(userId: string, limit = 50, offset = 0) {
        return prisma.chatLog.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: limit,
            skip: offset,
        });
    }

    async deleteOldLogs(before: Date) {
        return prisma.chatLog.deleteMany({
            where: {
                createdAt: { lt: before }
            }
        });
    }
}

export const chatLogRepository = new ChatLogRepository();
