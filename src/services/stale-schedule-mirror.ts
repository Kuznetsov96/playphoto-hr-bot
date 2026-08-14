import { logBusinessEvent } from "../core/log-events.js";
import { systemStateRepository } from "../repositories/system-state-repository.js";

/**
 * Six missed sync cycles. Long enough that a single failed request or a slow
 * backend passes unnoticed, short enough that a genuinely dead sync is caught
 * before a photographer travels to a shift that was moved.
 */
export const STALE_MIRROR_THRESHOLD_MS = 30 * 60_000;

/**
 * How long the same ongoing outage stays quiet after its first alert. A dead
 * sync stays dead, and this check runs on a loop — alerting every pass would
 * teach people to mute the bot, which costs more than the alert is worth.
 * One reminder every six hours is enough to keep an unfixed outage visible.
 */
export const STALE_MIRROR_REPEAT_MS = 6 * 60 * 60_000;

/** Written by `aws-business-sync` at the end of every successful pass. */
const LAST_SYNC_KEY = "aws-business-sync:last";

export type MirrorFreshness =
    | { stale: false; recovered?: true }
    | { stale: true; shouldNotify: boolean; staleForMinutes: number; lastSyncAt: string | null };

/**
 * Answers whether the local schedule mirror is still being refreshed.
 *
 * The mirror is the bot's only copy of the canonical schedule, and every screen
 * that is not a direct canonical read serves from it. When the sync stops, none
 * of those screens fail — they quietly keep showing whatever was last written,
 * so the failure surfaces as a photographer reporting a wrong schedule rather
 * than as an error anywhere in the system.
 *
 * `startedAt` exists for the missing-record case: a container that has just come
 * up legitimately has no record yet, and complaining about that on every deploy
 * would be noise. Past the threshold it stops being a fresh start and becomes a
 * sync that has never completed.
 */
export async function checkScheduleMirrorFreshness(input: {
    now: Date;
    alertedAt: Date | null;
    startedAt?: Date;
}): Promise<MirrorFreshness> {
    const record = await systemStateRepository.getJson<{ generatedAt?: unknown }>(LAST_SYNC_KEY);
    const raw = typeof record?.generatedAt === "string" ? record.generatedAt : null;
    const lastSyncAt = raw !== null && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : null;

    // An unreadable or absent record is never read as "fresh": that would hide
    // the exact failure this check exists for. It is measured from the process
    // start instead, so only a sync that has genuinely never landed is reported.
    const measuredFrom = lastSyncAt ?? input.startedAt ?? null;
    if (measuredFrom === null) return { stale: false };

    const silentForMs = input.now.getTime() - measuredFrom.getTime();
    if (silentForMs < STALE_MIRROR_THRESHOLD_MS) {
        // Recovery has to clear the alert state, or the repeat-suppression
        // window would swallow the next genuine outage.
        return input.alertedAt !== null ? { stale: false, recovered: true } : { stale: false };
    }

    const notifiedRecently =
        input.alertedAt !== null &&
        input.now.getTime() - input.alertedAt.getTime() < STALE_MIRROR_REPEAT_MS;

    return {
        stale: true,
        shouldNotify: !notifiedRecently,
        staleForMinutes: Math.floor(silentForMs / 60_000),
        lastSyncAt: raw,
    };
}

/** Where the last alert time is kept, so a restart cannot reset the anti-spam window. */
const ALERT_STATE_KEY = "schedule-mirror:last-alert";

/**
 * How often the freshness check itself runs. Deliberately coarser than the sync
 * interval: this watches for an outage lasting half an hour, so checking every
 * five minutes would only add noise to the logs.
 */
const CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Watches that the schedule mirror keeps being refreshed, and tells the admins
 * once when it stops.
 *
 * Notification is deliberately conservative: one message per outage, one
 * reminder every six hours while it persists, nothing at all when the sync is
 * healthy. An alert people learn to ignore is worse than no alert, because it
 * also buries the ones that matter.
 */
export function startScheduleMirrorWatch(api: {
    sendMessage(chatId: number, text: string, options?: { parse_mode?: "HTML" }): Promise<unknown>;
}, adminIds: number[]): NodeJS.Timeout {
    const startedAt = new Date();

    const run = async () => {
        const stored = await systemStateRepository.getJson<{ at?: unknown }>(ALERT_STATE_KEY);
        const alertedAt =
            typeof stored?.at === "string" && !Number.isNaN(Date.parse(stored.at))
                ? new Date(stored.at)
                : null;

        const result = await checkScheduleMirrorFreshness({ now: new Date(), alertedAt, startedAt });

        if (!result.stale) {
            if (result.recovered) {
                await systemStateRepository.setJson(ALERT_STATE_KEY, { at: null });
                logBusinessEvent({
                    event: "bot.schedule_mirror.recovered",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "stale-schedule-mirror",
                    operation: "watch",
                });
            }
            return;
        }

        logBusinessEvent({
            event: "bot.schedule_mirror.stale",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "degraded",
            reasonCode: "STALE_SCHEDULE_MIRROR",
            module: "stale-schedule-mirror",
            operation: "watch",
            safeContext: { staleForMinutes: result.staleForMinutes, lastSyncAt: result.lastSyncAt },
        });

        if (!result.shouldNotify) return;

        const text =
            `⚠️ <b>Графік не оновлюється</b>\n\n` +
            `Синхронізація з вебаппом не відпрацювала вже ${result.staleForMinutes} хв.\n` +
            `Фотографи бачать графік станом на ${result.lastSyncAt ?? "невідомо"}.\n\n` +
            `Нові зміни й заміни з вебаппа до бота зараз не доходять.`;

        // One failed admin must not stop the others from being told, and a
        // delivery failure must not abort the watch loop itself.
        for (const adminId of adminIds) {
            await api.sendMessage(adminId, text, { parse_mode: "HTML" }).catch(() => undefined);
        }
        await systemStateRepository.setJson(ALERT_STATE_KEY, { at: new Date().toISOString() });
    };

    const timer = setInterval(() => {
        void run().catch((error: unknown) => {
            logBusinessEvent({
                event: "bot.schedule_mirror.check_failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "stale-schedule-mirror",
                operation: "watch",
                safeContext: {
                    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                },
            });
        });
    }, CHECK_INTERVAL_MS);
    timer.unref();
    return timer;
}
