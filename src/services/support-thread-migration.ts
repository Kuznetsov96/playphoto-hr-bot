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
const LEASE_MS = 2 * 60 * 60 * 1000;
/**
 * Ліміт Telegram — 20 повідомлень на хвилину в групі, а на людину йде 4–6
 * (тема, картка, закріп, «Previous», «Moved» у кожну стару). 20 с — щоб перехід
 * не придушив живу підтримку на весь свій час.
 */
const PAUSE_BETWEEN_PEOPLE_MS = 20_000;
const LINK_RETENTION_MS = 90 * 86_400_000;

type RedisLike = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
    del(key: string): Promise<number>;
};

export type MigrationDeps = {
    redis: RedisLike;
    repo: Pick<SupportThreadRepository, "listLegacyActive" | "closeLegacy">;
    threads: Pick<SupportThreadService, "ensureThread">;
    supportChatId: () => number;
    topicLink: (chatId: bigint, topicId: number) => string;
    sleep: (ms: number) => Promise<void>;
};

export async function migrateLegacyConversations(api: Api, deps: MigrationDeps): Promise<{ migrated: number; skipped: number; failed: number }> {
    const result = { migrated: 0, skipped: 0, failed: 0 };
    if (await deps.redis.get(DONE_KEY)) return result;
    if ((await deps.redis.set(LEASE_KEY, String(process.pid), "PX", LEASE_MS, "NX")) !== "OK") return result;

    try {
        const rows = await deps.repo.listLegacyActive(BigInt(deps.supportChatId()));
        for (const [index, row] of rows.entries()) {
            if (index > 0) await deps.sleep(PAUSE_BETWEEN_PEOPLE_MS);
            let thread;
            try {
                thread = await deps.threads.ensureThread(api, row.userId);
            } catch (error) {
                if (/no staff profile/i.test(String((error as Error)?.message))) {
                    result.skipped++; // кандидатка — її старий контур не чіпаємо
                    continue;
                }
                result.failed++;
                logger.error({ err: error, userId: row.userId }, "Support thread migration failed for a person");
                continue;
            }

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
            await deps.repo.closeLegacy({ ticketIds: row.ticketIds, outgoingIds: row.outgoingIds, proofIds: row.proofIds });
            result.migrated++;
        }
        if (result.failed === 0) await deps.redis.set(DONE_KEY, "1");
        logger.info({ event: "support.threads.migration.completed", ...result }, "Support thread migration finished");
        return result;
    } finally {
        await deps.redis.del(LEASE_KEY).catch(() => 0);
    }
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
