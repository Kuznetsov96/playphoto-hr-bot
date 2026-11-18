import prisma from "../db/core.js";
import logger from "../core/logger.js";

/**
 * Копія списку заборонених Telegram ID. Рішення «блокувати чи ні» береться лише звідси.
 * Id завжди bigint: Number() губить точність вище 2^53.
 */
let ids = new Set<bigint>();
let loaded = false;
/** Збільшується після кожного коміту replaceAll; читання, що почалося раніше, не має права затерти свіжий список. */
let generation = 0;
let inFlight: Promise<boolean> | null = null;
let lastFailureAt = -Infinity;
const RETRY_AFTER_MS = 5_000;

export const telegramBlocklist = {
    isLoaded(): boolean {
        return loaded;
    },

    has(id: number | bigint): boolean {
        return ids.has(typeof id === "bigint" ? id : BigInt(id));
    },

    /**
     * true, якщо список у пам'яті готовий; при помилці бази лог і false.
     * Паралельні виклики ділять один запит; після збою база не опитується частіше ніж раз на RETRY_AFTER_MS.
     */
    async ensureLoaded(): Promise<boolean> {
        if (loaded) return true;
        if (inFlight) return inFlight;
        if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return false;
        const startedAt = generation;
        const attempt = (async () => {
            try {
                const rows = await prisma.blockedTelegramId.findMany({ select: { telegramId: true } });
                // replaceAll міг закомітитися, поки йшло читання: його дані свіжіші за ці рядки.
                if (generation === startedAt && !loaded) {
                    ids = new Set(rows.map(r => r.telegramId));
                    loaded = true;
                }
                return loaded;
            } catch (err) {
                lastFailureAt = Date.now();
                logger.error({ err }, "telegram-blocklist: failed to load BlockedTelegramId");
                return false;
            }
        })();
        inFlight = attempt;
        void attempt.finally(() => {
            if (inFlight === attempt) inFlight = null;
        });
        return attempt;
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
        generation += 1;
        return { before, after: ids.size };
    },
};
