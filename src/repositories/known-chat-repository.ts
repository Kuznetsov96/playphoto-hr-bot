import prisma from "../db/core.js";

export class KnownChatRepository {
    async recordPresent(chat: { id: bigint; title?: string | null; type: string }): Promise<void> {
        await prisma.knownChat.upsert({
            where: { id: chat.id },
            create: {
                id: chat.id,
                title: chat.title ?? null,
                type: chat.type
            },
            update: {
                title: chat.title ?? null,
                type: chat.type,
                lostAt: null
            }
        });
    }

    async recordLost(id: bigint): Promise<void> {
        await prisma.knownChat.update({
            where: { id },
            data: { lostAt: new Date() }
        });
    }

    async listActive(): Promise<Array<{ id: bigint; title: string | null }>> {
        return prisma.knownChat.findMany({
            where: { lostAt: null },
            select: { id: true, title: true }
        });
    }
}

export const knownChatRepository = new KnownChatRepository();
