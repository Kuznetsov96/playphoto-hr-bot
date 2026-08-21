import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { broadcastService } from "./broadcast.js";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";
import { logBusinessEvent } from "../core/log-events.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { formatDeadline, kyivDeadline } from "../utils/format-deadline.js";

/**
 * Service to handle monthly schedule preference collection.
 */
/** До какого числа принимаются пожелания. Рассылка уходит 23-го. */
const DEADLINE_DAY_OF_MONTH = 26;

export class MonthlyPreferencesTrigger {
    /**
     * Triggers the monthly broadcast to all active staff.
     * Scheduled for the 23rd of every month.
     */
    static async trigger(bot: Bot<MyContext>) {
        const now = new Date();
        // Use Kyiv time for month name
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
        const monthName = nextMonth.toLocaleString('uk-UA', { month: 'long' });

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

        // Дедлайн — 26-е число текущего месяца, через три дня после рассылки.
        // Дата, а не «2 дні»: относительный срок каждый считает по-своему,
        // а день недели выводится из самой даты и потому не разойдётся с ней.
        const deadlineDate = kyivDeadline(now, DEADLINE_DAY_OF_MONTH);
        const messageText = STAFF_TEXTS["staff-preferences-invite"]({
            monthName,
            deadline: formatDeadline(deadlineDate),
        });

        try {
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
                    repeatIntervalMs: 4 * 60 * 60 * 1000,    // 4 hours
                    // Напоминания смолкают вместе с окном: после дедлайна
                    // форма отвечает «збір закрито», и звать в неё — издевка.
                    pingUntil: deadlineDate,
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
            logger.error({ err: e }, "Monthly preferences trigger failed");
            logBusinessEvent({
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
     * Checks if it's the 23rd and triggers the broadcast if it hasn't been sent yet today.
     */
    static async checkAndTrigger(bot: Bot<MyContext>) {
        const now = new Date();
        // Use Kyiv time for consistent date checking
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        
        // Catch up after 10:00 if the service was restarting at the exact scheduled minute.
        if (kyivDate.getDate() === 23 && kyivDate.getHours() >= 10) {
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
