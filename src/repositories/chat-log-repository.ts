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

    /**
     * Retention policy delete:
     * - active staff: never deleted;
     * - former staff: kept until `formerStaffDeactivatedBefore` (3y archive after dismissal),
     *   profiles without deactivatedAt are kept as a safety net;
     * - everyone else (candidates, unregistered): deleted once older than `before`.
     * Matches staff both via ChatLog.userId and via telegramId, so pre-registration
     * rows of current staff are preserved too.
     */
    async deleteExpired(before: Date, formerStaffDeactivatedBefore: Date): Promise<number> {
        return prisma.$executeRaw`
            DELETE FROM "ChatLog" cl
            WHERE cl."createdAt" < ${before}
              AND NOT EXISTS (
                SELECT 1
                FROM "User" u
                JOIN "StaffProfile" sp ON sp."userId" = u.id
                WHERE (u.id = cl."userId" OR u."telegramId" = cl."telegramId")
                  AND (
                    sp."isActive" = true
                    OR sp."deactivatedAt" IS NULL
                    OR sp."deactivatedAt" >= ${formerStaffDeactivatedBefore}
                  )
              )
        `;
    }
}

export const chatLogRepository = new ChatLogRepository();
