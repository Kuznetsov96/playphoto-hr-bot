import { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { taskService } from "./task-service.js";
import { staffHubMenu } from "../menus/staff.js";
import logger from "../core/logger.js";

export async function sendDailyShiftReminders(bot: Bot<MyContext>) {
    logger.info("[Cron] Starting daily shift reminders...");

    const now = new Date();
    // Use Kyiv time for the date check
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    
    const startOfDay = new Date(kyivNow);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(kyivNow);
    endOfDay.setHours(23, 59, 59, 999);

    try {
        const todayShifts = await workShiftRepository.findWithRelationsByDateRange(startOfDay, endOfDay);
        
        if (todayShifts.length === 0) {
            logger.info("[Cron] No shifts found for today.");
            return;
        }

        logger.info(`[Cron] Found ${todayShifts.length} shifts. Sending notifications...`);

        for (const shift of todayShifts) {
            const staff = shift.staff;
            const telegramId = (staff as any).user?.telegramId;

            if (!telegramId) {
                logger.warn({ staffId: staff.id }, "[Cron] Staff has no telegramId, skipping.");
                continue;
            }

            try {
                // Prepare the text (similar to showStaffHub)
                const dateStr = shift.date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
                const shiftText = `🏃 <b>Сьогодні (${dateStr}) у тебе зміна в ${shift.location.name}!</b> 📸
Вдалого дня та гарних знімків! ✨`;

                const tasks = await taskService.getStaffActiveTasks(staff.id);
                const activeTasksCount = tasks.filter(t => !t.isCompleted).length;
                const taskSummary = activeTasksCount > 0 
                    ? `

🔴 <b>У тебе є активні завдання (${activeTasksCount})!</b>
Переглянь їх у розділі «Мої завдання». 👇`
                    : "";

                const firstName = staff.fullName?.split(' ')[1] || staff.fullName?.split(' ')[0] || 'фотографе';
                const greeting = `👋 <b>Доброго ранку, ${firstName}!</b>

Ось твій робочий хаб на сьогодні:`;
                
                const fullText = `${greeting}

${shiftText}${taskSummary}`;

                // Send in quiet mode (disable_notification: true)
                const sentMsg = await bot.api.sendMessage(Number(telegramId), fullText, {
                    parse_mode: "HTML",
                    reply_markup: staffHubMenu,
                    disable_notification: true
                });

                // Note: We don't update lastMenuMessageId here because we don't have access to the user's session easily.
                // However, the first time the user clicks a button, the session will be updated by the menu handler.
                
                logger.info({ telegramId }, "[Cron] Shift reminder sent.");
            } catch (err) {
                logger.error({ err, telegramId }, "[Cron] Failed to send shift reminder.");
            }
        }
    } catch (error) {
        logger.error({ error }, "[Cron] Error in daily shift reminders service.");
    }
}

export function startShiftReminderLoop(bot: Bot<MyContext>) {
    // We want to run this at 08:00 AM Kyiv time every day
    const now = new Date();
    
    // Calculate 08:00 today in Kyiv
    let nextRun = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    nextRun.setHours(8, 0, 0, 0);

    // If it's already past 8 AM today, schedule for tomorrow
    if (now >= nextRun) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    const delay = nextRun.getTime() - now.getTime();
    logger.info(`[Cron] Shift reminder loop started. Next run at ${nextRun.toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })} (in ${(delay / 1000 / 60 / 60).toFixed(2)} hours)`);

    setTimeout(() => {
        sendDailyShiftReminders(bot).catch(e => logger.error(e, "[Cron] Failed to run initial shift reminders"));
        setInterval(() => sendDailyShiftReminders(bot), 24 * 60 * 60 * 1000);
    }, delay);
}
