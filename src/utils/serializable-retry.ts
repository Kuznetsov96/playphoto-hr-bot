import { logBusinessEvent } from "../core/log-events.js";

/**
 * Serializable-транзакція за стандартом Postgres може бути скасована при конфлікті, і
 * клієнт зобов'язаний її повторити. Без повтору синк знімка падав приблизно щодня о 08:03,
 * коли збігався з ранковим дайджестом, і чекав наступного проходу через 5 хвилин.
 */
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

/** P2034 від Prisma; deadlock буває без нього, лише з кодом Postgres у тексті помилки. */
export function isTransactionConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === "P2034") return true;
    return typeof message === "string" && /code: "(40001|40P01)"/.test(message);
}

/**
 * Повторює лише конфлікт, з обмеженою кількістю спроб і експоненційною стелею затримки з
 * випадковим розкидом (full jitter), щоб учасники конфлікту не зіткнулись знову одночасно.
 * Текст помилки в подію не потрапляє: Prisma кладе туди значення полів, а це персональні дані.
 *
 * `run` викликається заново цілком, тож стан поза транзакцією він мусить скидати сам.
 */
export async function withSerializableRetry<T>(
    operation: string,
    run: () => Promise<T>,
    options: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<T> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = options.random ?? Math.random;
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (attempt > MAX_RETRIES || !isTransactionConflict(error)) throw error;
            logBusinessEvent({
                event: "bot.serializable_transaction.retry",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "degraded",
                reasonCode: "TRANSACTION_CONFLICT",
                module: "serializable-retry",
                operation,
                safeContext: { attempt },
            });
            await sleep(Math.floor(random() * BASE_DELAY_MS * 2 ** (attempt - 1)));
        }
    }
}
