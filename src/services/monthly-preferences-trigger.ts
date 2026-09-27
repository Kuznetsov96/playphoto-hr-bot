import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { broadcastService } from "./broadcast.js";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";
import { logBusinessEvent } from "../core/log-events.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { formatLocalDate } from "../utils/format-deadline.js";
import { awsBusinessClient } from "./aws-business-client.js";
import { monthNameFromCanonical, nextCanonicalMonth } from "./preference-month.js";

/**
 * Рассылка 23-го: приглашение подать пожелания на следующий месяц.
 *
 * Срок сбора своего у бота больше нет — он хранится в вебаппе (26-е по
 * умолчанию, владелец может перенести) и приходит из `collection-schedule`.
 * Напоминания тоже спрашивают его заново перед каждой отправкой (pinger.ts).
 */

/**
 * Жёсткий предел напоминаний — первое число после месяца графика. Позже срок
 * не переносится, а без предела строка без ответа пинговалась бы вечно: при
 * откате на старый код (он пингует «до ответа», если `pingUntil` пуст) или
 * если вебапп так и не ответит.
 */
function firstDayAfter(month: string): Date {
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(year, monthNumber, 1));
}

/** Сбой вебаппа повторяется каждую минуту — в журнал он пишется раз в полчаса. */
const FAILURE_LOG_EVERY_MS = 30 * 60 * 1000;
let lastFailureLoggedAt = 0;

export class MonthlyPreferencesTrigger {
    /**
     * Triggers the monthly broadcast to all active staff.
     * Scheduled for the 23rd of every month.
     */
    static async trigger(bot: Bot<MyContext>) {
        const now = new Date();
        // Use Kyiv time for month name
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const targetMonth = nextCanonicalMonth(now);
        const monthName = monthNameFromCanonical(targetMonth) ?? targetMonth;

        const triggerKey = `monthly_pref_triggered:${kyivNow.getFullYear()}-${kyivNow.getMonth() + 1}`;
        
        // Atomically acquire the monthly trigger so parallel instances cannot enqueue twice.
        const acquired = await redis.set(triggerKey, "true", "EX", 32 * 24 * 60 * 60, "NX");
        if (acquired !== "OK") {
            logger.debug(`[MonthlyPref] Already triggered for ${monthName}, skipping.`);
            logBusinessEvent({
                event: "staff.preferences_monthly_trigger.skipped",
                actorType: "system",
                actorRole: "system",
                result: "skipped",
                reasonCode: "ALREADY_TRIGGERED",
                module: "monthly-preferences-trigger",
                operation: "trigger",
                safeContext: {
                    monthName,
                },
            });
            return;
        }

        try {
            // Срок — из вебаппа. Недоступен API — рассылка не уходит, а ключ
            // освобождается (catch ниже): следующий тик через минуту повторит.
            // Разослать с угаданной датой хуже, чем на минуту позже.
            const schedule = await awsBusinessClient.schedulePreferenceSchedule(targetMonth);
            if (!schedule.open) {
                // Владелец закрыл сбор раньше рассылки — звать некуда.
                logger.warn({ targetMonth }, "[MonthlyPref] Collection already closed, invites not sent");
                return;
            }
            // Срок уже прошёл — приглашать поздно. Попытки идут с 23-го до конца
            // месяца (вебапп мог лежать весь день), и без этой проверки выкат
            // бота после срока с пустым Redis разослал бы приглашение повторно.
            if (Date.now() >= new Date(schedule.deadlineEndsAt).getTime()) {
                logger.warn({ targetMonth, deadline: schedule.deadline }, "[MonthlyPref] Deadline passed, invites not sent");
                return;
            }
            // Дата, а не «2 дні»: относительный срок каждый считает по-своему,
            // а день недели выводится из самой даты и потому не разойдётся с ней.
            const messageText = STAFF_TEXTS["staff-preferences-invite"]({
                monthName,
                deadline: formatLocalDate(schedule.deadline),
            });

            // Queue the broadcast after acquiring the distributed monthly lock.
            const totalSent = await broadcastService.createBroadcast(
                bot.api,
                0, // System initiator (ID 0 for system messages)
                messageText,
                { type: 'pm_all' },
                undefined,
                undefined, // Skip bot username here if not used
                {
                    initialDelayMs: 2 * 24 * 60 * 60 * 1000, // 2 days
                    // 6 часов, а не 4: ночью пингер молчит (тихое окно
                    // PING_CONFIG.QUIET_FROM_HOUR), и в дневном окне 10:00–22:00
                    // шестичасовой шаг даёт два напоминания в день вместо трёх —
                    // достаточно, чтобы достучаться до забывчивого.
                    repeatIntervalMs: 6 * 60 * 60 * 1000,    // 6 hours
                    // Срок и «сбор открыт» пингер спрашивает у вебаппа по месяцу
                    // перед каждым напоминанием: зашитый в строку срок не узнал
                    // бы ни о переносе, ни о закрытии. `pingUntil` — только
                    // предел на крайний случай, конец месяца графика.
                    targetMonth,
                    pingUntil: firstDayAfter(targetMonth),
                    buttonType: 'preferences'
                }
            );

            logBusinessEvent({
                event: "staff.preferences_monthly_trigger.completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "monthly-preferences-trigger",
                operation: "trigger",
                safeContext: {
                    monthName,
                    totalSent,
                },
            });
        } catch (e: any) {
            // Ключ освобождается всегда — повтор через минуту. Журнал — нет:
            // лежащий вебапп иначе давал бы сотни ошибок за день.
            const shouldLog = Date.now() - lastFailureLoggedAt >= FAILURE_LOG_EVERY_MS;
            if (shouldLog) lastFailureLoggedAt = Date.now();
            if (shouldLog) logger.error({ err: e }, "Monthly preferences trigger failed");
            if (shouldLog) logBusinessEvent({
                event: "staff.preferences_monthly_trigger.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "MONTHLY_PREFERENCES_TRIGGER_FAILED",
                module: "monthly-preferences-trigger",
                operation: "trigger",
                safeContext: {
                    monthName,
                },
                error: e,
            });
            // Enqueue failed, so release the key and allow the next scheduler tick to retry.
            await redis.del(triggerKey).catch(deleteError => {
                logger.error({ err: deleteError, triggerKey }, "Failed to release monthly preference trigger key");
            });
        }
    }

    /**
     * From the 23rd on, triggers the broadcast if it has not been sent this month.
     */
    static async checkAndTrigger(bot: Bot<MyContext>) {
        const now = new Date();
        // Use Kyiv time for consistent date checking
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        
        // С 23-го до конца месяца, после 10:00: рассылка уходит один раз (ключ
        // месяца в Redis), но если вебапп лежал весь 23-й, она уйдёт 24-го, а
        // не пропадёт на месяц. После срока `trigger` сам откажется.
        if (kyivDate.getDate() >= 23 && kyivDate.getHours() >= 10) {
            await this.trigger(bot);
        }
    }
}

export function startMonthlyPreferencesLoop(bot: Bot<MyContext>) {
    logBusinessEvent({
        event: "staff.preferences_monthly_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "monthly-preferences-trigger",
        operation: "startMonthlyPreferencesLoop",
    });
    // Check every minute
    setInterval(() => MonthlyPreferencesTrigger.checkAndTrigger(bot), 60 * 1000);
}
