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

    /**
     * `type` выдаётся наравне с идентификатором, потому что правила отзыва
     * различаются по типу чата: в канале с постоянной ссылкой бан нужен и тому,
     * кто сейчас `left`, а в групповом чате локации — нет. Чтобы отличать их не
     * захардкоженным списком id (ради ухода от которого реестр и заводился),
     * признак должен ехать из базы вместе со строкой.
     */
    async listActive(): Promise<Array<{ id: bigint; title: string | null; type: string }>> {
        return prisma.knownChat.findMany({
            where: { lostAt: null },
            select: { id: true, title: true, type: true }
        });
    }
}

export const knownChatRepository = new KnownChatRepository();
