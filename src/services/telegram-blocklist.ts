import prisma from "../db/core.js";
import logger from "../core/logger.js";

/**
 * Копія списку заборонених Telegram ID. Рішення «блокувати чи ні» береться лише звідси.
 * Id завжди bigint: Number() губить точність вище 2^53.
 */
let ids = new Set<bigint>();
let loaded = false;

export const telegramBlocklist = {
    isLoaded(): boolean {
        return loaded;
    },

    has(id: number | bigint): boolean {
        return ids.has(typeof id === "bigint" ? id : BigInt(id));
    },

    /** true, якщо список у пам'яті готовий; при помилці бази лог і false, наступний виклик пробує знову. */
    async ensureLoaded(): Promise<boolean> {
        if (loaded) return true;
        try {
            const rows = await prisma.blockedTelegramId.findMany({ select: { telegramId: true } });
            ids = new Set(rows.map(r => r.telegramId));
            loaded = true;
            return true;
        } catch (err) {
            logger.error({ err }, "telegram-blocklist: failed to load BlockedTelegramId");
            return false;
        }
    },

    async replaceAll(next: readonly bigint[]): Promise<{ before: number; after: number }> {
        const unique = [...new Set(next)];
        await prisma.$transaction(async tx => {
            await tx.blockedTelegramId.deleteMany({});
            if (unique.length > 0) {
                await tx.blockedTelegramId.createMany({
                    data: unique.map(telegramId => ({ telegramId })),
                    skipDuplicates: true,
                });
            }
        });
        const before = ids.size;
        ids = new Set(unique);
        loaded = true;
        return { before, after: ids.size };
    },
};
