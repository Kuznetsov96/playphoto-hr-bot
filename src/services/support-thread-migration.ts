import type { Api } from "grammy";
import logger from "../core/logger.js";
import type { SupportThreadRepository } from "../repositories/support-thread-repository.js";
import { kyivDay } from "../utils/support-thread-format.js";
import type { SupportThreadService } from "./support-thread-service.js";

/**
 * Разовий перехід зі старих тікетів, вихідних тем і тем задач на постійні теми
 * (spec 2026-10-08). Повторний запуск безпечний: закриті старі розмови вже не
 * потрапляють у вибірку, а позначка «готово» ставиться лише без збоїв.
 */

const DONE_KEY = "support:threads:migrated:v1";
const LEASE_KEY = "support:threads:migration:lease";
/** Короткий лок, що продовжується на кожній людині: упав процес — повтор за хвилини, а не за години. */
const LEASE_MS = 5 * 60 * 1000;
/**
 * Ліміт Telegram — 20 повідомлень на хвилину в групі, а на людину йде 4–6
 * (тема, картка, закріп, «Previous», «Moved» у кожну стару). 20 с — щоб перехід
 * не придушив живу підтримку на весь свій час.
 */
const PAUSE_BETWEEN_PEOPLE_MS = 20_000;
const LINK_RETENTION_MS = 90 * 86_400_000;
const FAIL_KEY_PREFIX = "support:threads:migration:fail:";
const NOTED_KEY_PREFIX = "support:threads:migration:noted:";
/** Після стількох збоїв людина пропускається, щоб перехід не крутився вічно. */
const MAX_ATTEMPTS_PER_PERSON = 3;
const FAIL_TTL_S = 30 * 86_400;

type RedisLike = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
    del(key: string): Promise<number>;
};

export type MigrationDeps = {
    redis: RedisLike;
    repo: Pick<SupportThreadRepository, "listLegacyActive" | "closeLegacy">;
    threads: Pick<SupportThreadService, "ensureThread" | "applyStatus">;
    supportChatId: () => number;
    topicLink: (chatId: bigint, topicId: number) => string;
    sleep: (ms: number) => Promise<void>;
};

export async function migrateLegacyConversations(api: Api, deps: MigrationDeps): Promise<{ migrated: number; skipped: number; failed: number }> {
    const result = { migrated: 0, skipped: 0, failed: 0 };
    if (await deps.redis.get(DONE_KEY)) return result;
    const token = `${process.pid}:${Date.now()}`;
    if ((await deps.redis.set(LEASE_KEY, token, "PX", LEASE_MS, "NX")) !== "OK") return result;

    try {
        const rows = await deps.repo.listLegacyActive(BigInt(deps.supportChatId()));
        let migratedBefore = false;
        for (const row of rows) {
            const failKey = `${FAIL_KEY_PREFIX}${row.userId}`;
            if (Number(await deps.redis.get(failKey) ?? 0) >= MAX_ATTEMPTS_PER_PERSON) {
                result.skipped++; // кілька спроб не вдалося — у журналі є причина, перехід не тримаємо
                continue;
            }

            let thread;
            try {
                thread = await deps.threads.ensureThread(api, row.userId);
            } catch (error) {
                if (/no staff profile/i.test(String((error as Error)?.message))) {
                    result.skipped++; // кандидатка — її старий контур не чіпаємо
                    continue;
                }
                await countFailure(deps, failKey, result);
                logger.error({ err: error, userId: row.userId }, "Support thread migration failed for a person");
                continue;
            }

            // Пауза — лише між справжніми перенесеннями, кандидатки її не чекають.
            if (migratedBefore) await deps.sleep(PAUSE_BETWEEN_PEOPLE_MS);
            migratedBefore = true;
            await deps.redis.set(LEASE_KEY, token, "PX", LEASE_MS);

            try {
                // Рядки «Previous/Moved» — раз на людину, навіть якщо процес упав після них.
                const notedKey = `${NOTED_KEY_PREFIX}${row.userId}`;
                if (!(await deps.redis.get(notedKey))) {
                    const newLink = deps.topicLink(thread.chatId, thread.topicId);
                    if (row.topics.length) {
                        const previous = row.topics.map(topic => deps.topicLink(topic.chatId, topic.topicId)).join(" · ");
                        await api.sendMessage(Number(thread.chatId), `⬅️ Previous conversation: ${previous}`, { message_thread_id: thread.topicId })
                            .catch(error => logger.warn({ err: error, threadId: thread.id }, "Previous-conversation note failed"));
                    }
                    for (const topic of row.topics) {
                        await api.sendMessage(Number(topic.chatId), `➡️ Moved to the permanent topic: ${newLink}`, { message_thread_id: topic.topicId })
                            .catch(error => logger.warn({ err: error, topicId: topic.topicId }, "Moved note failed"));
                        await api.closeForumTopic(Number(topic.chatId), topic.topicId)
                            .catch(error => logger.warn({ err: error, topicId: topic.topicId }, "Legacy topic close failed"));
                    }
                    await deps.redis.set(notedKey, "1", "EX", FAIL_TTL_S);
                }
                if (row.waiting) await deps.threads.applyStatus(api, thread, { kind: "bot_context" });
                await deps.repo.closeLegacy({ ticketIds: row.ticketIds, outgoingIds: row.outgoingIds, proofIds: row.proofIds });
                result.migrated++;
            } catch (error) {
                await countFailure(deps, failKey, result);
                logger.error({ err: error, userId: row.userId }, "Support thread migration failed for a person");
            }
        }
        if (result.failed === 0) await deps.redis.set(DONE_KEY, "1");
        logger.info({ event: "support.threads.migration.completed", ...result }, "Support thread migration finished");
        return result;
    } finally {
        // Лише свій лок: якщо наш устиг протухнути, його вже тримає інший процес.
        if ((await deps.redis.get(LEASE_KEY).catch(() => null)) === token) {
            await deps.redis.del(LEASE_KEY).catch(() => 0);
        }
    }
}

/** Збій рахується; на останній дозволеній спробі людина вже «пропущена», а не «збій». */
async function countFailure(deps: MigrationDeps, failKey: string, result: { skipped: number; failed: number }) {
    const attempts = Number(await deps.redis.get(failKey) ?? 0) + 1;
    await deps.redis.set(failKey, String(attempts), "EX", FAIL_TTL_S);
    if (attempts >= MAX_ATTEMPTS_PER_PERSON) result.skipped++;
    else result.failed++;
}

export type DailyDeps = {
    redis: Pick<RedisLike, "set">;
    threads: Pick<SupportThreadService, "archiveInactive" | "dailyRefresh">;
    repo: Pick<SupportThreadRepository, "deleteLinksOlderThan">;
};

/** О 7-й за Києвом: архів звільнених, назви й картки, прибирання пар старших за 90 днів. */
export async function runDailySupportThreadJobs(api: Api, deps: DailyDeps, now: Date = new Date()): Promise<boolean> {
    const hour = Number(now.toLocaleString("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hour12: false }));
    if (hour !== 7) return false;
    if ((await deps.redis.set(`support:threads:daily:${kyivDay(now)}`, "1", "EX", 2 * 86_400, "NX")) !== "OK") return false;

    await deps.threads.archiveInactive(api, now);
    await deps.threads.dailyRefresh(api, now);
    await deps.repo.deleteLinksOlderThan(new Date(now.getTime() - LINK_RETENTION_MS));
    return true;
}

/**
 * Один крок фонового циклу: перехід (якщо ще не позначений «готово» — коштує
 * одне читання Redis) і щоденні задачі. Збій одного не зриває іншого.
 */
export async function runSupportThreadTick(api: Api, migration: MigrationDeps, daily: DailyDeps, now: Date = new Date()): Promise<void> {
    // Щоденні — першими: перехід може тривати пів години й не має з'їсти вікно о 7-й.
    try {
        await runDailySupportThreadJobs(api, daily, now);
    } catch (error) {
        logger.error({ err: error }, "Support thread daily jobs failed");
    }
    try {
        await migrateLegacyConversations(api, migration);
    } catch (error) {
        logger.error({ err: error }, "Support thread migration tick failed");
    }
}
