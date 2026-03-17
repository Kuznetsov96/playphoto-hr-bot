import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { broadcastService } from "./broadcast.js";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";

/**
 * Service to handle monthly schedule preference collection.
 */
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
        
        // 1. Double check in Redis (Atomic check-and-set would be better but this is sufficient for 1-minute interval)
        const alreadyTriggered = await redis.get(triggerKey);
        if (alreadyTriggered) {
            logger.debug(`[MonthlyPref] Already triggered for ${monthName}, skipping.`);
            return;
        }

        logger.info(`📅 Triggering monthly schedule preferences broadcast for ${monthName}...`);

        const messageText = `📢 <b>Побажання на ${monthName}</b>\n\nПривіт! Час планувати графік на наступний місяць. 😊\n\nБудь ласка, познач дні, коли ти <b>НЕ ЗМОЖЕШ</b> вийти на зміну. \n\nДедлайн: <b>2 дні</b>. Після цього бот почне нагадувати тобі кожні 4 години! ⏳\n\nНатисни кнопку нижче, щоб заповнити:`;

        try {
            // 2. Mark as triggered in Redis BEFORE sending to prevent race conditions during long async operations
            await redis.set(triggerKey, "true", "EX", 32 * 24 * 60 * 60); // Expire in 32 days

            // 3. Send broadcast to all staff PMs
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
                    buttonType: 'preferences'
                }
            );

            logger.info({ totalSent }, "✅ Monthly preferences broadcast sent and queued for pings.");
        } catch (e: any) {
            logger.error({ err: e.message }, "❌ Failed to trigger monthly preferences");
            // Optional: reset triggerKey if it failed completely? 
            // Better to leave it and let admin trigger manually if needed.
        }
    }

    /**
     * Checks if it's the 23rd and triggers the broadcast if it hasn't been sent yet today.
     */
    static async checkAndTrigger(bot: Bot<MyContext>) {
        const now = new Date();
        // Use Kyiv time for consistent date checking
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        
        // Trigger on the 23rd, at 10:00 AM Kyiv time
        if (kyivDate.getDate() === 23 && kyivDate.getHours() === 10 && kyivDate.getMinutes() === 0) {
            await this.trigger(bot);
        }
    }
}

export function startMonthlyPreferencesLoop(bot: Bot<MyContext>) {
    logger.info("📅 Starting monthly preferences loop...");
    // Check every minute
    setInterval(() => MonthlyPreferencesTrigger.checkAndTrigger(bot), 60 * 1000);
}
