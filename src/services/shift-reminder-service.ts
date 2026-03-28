import { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { taskService } from "./task-service.js";
import { staffHubMenu } from "../menus/staff.js";
import { CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";
import prisma from "../db/core.js";

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

        // Pre-fetch onboarding candidates (HIRED + isMentorLocked) with firstShiftDate = today
        const onboardingCandidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.HIRED,
                isMentorLocked: true,
                firstShiftDate: { gte: startOfDay, lte: endOfDay }
            },
            include: { user: true, location: true }
        });
        const onboardingByUserId = new Map(onboardingCandidates.map(c => [c.userId, c]));

        for (const shift of todayShifts) {
            const staff = shift.staff;
            const telegramId = (staff as any).user?.telegramId;

            if (!telegramId) {
                logger.warn({ staffId: staff.id }, "[Cron] Staff has no telegramId, skipping.");
                continue;
            }

            try {
                const isFirstShift = onboardingByUserId.has(staff.userId);

                if (isFirstShift) {
                    // First shift — special onboarding message
                    const locSchedule = shift.location.schedule;
                    let shiftTime = "";
                    if (locSchedule) {
                        const isWeekend = [0, 6].includes(shift.date.getDay());
                        const match = isWeekend
                            ? locSchedule.match(/Сб-Нд\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i)
                            : locSchedule.match(/Пн-Пт\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i);
                        if (match) shiftTime = match[1]!;
                    }

                    let text = `🌟 <b>Сьогодні твій перший робочий день!</b>\n\n` +
                        `Ти вже частина команди PlayPhoto, і ми дуже раді, що ти з нами. 📸\n\n` +
                        `📍 <b>${shift.location.name}</b>\n`;
                    if (shiftTime) text += `🕐 <b>${shiftTime}</b>\n`;
                    text += `\nНе хвилюйся — наша наставниця буде на зв'язку онлайн протягом зміни і допоможе з усім розібратися.\n\n` +
                        `Впевнені, що все пройде чудово. Вдалого першого дня! ✨`;

                    const kb = new InlineKeyboard().text("🚀 Відкрити Хаб", "staff_hub_nav");
                    await bot.api.sendMessage(Number(telegramId), text, { parse_mode: "HTML", reply_markup: kb });
                    logger.info({ telegramId }, "[Cron] First shift onboarding reminder sent to photographer.");
                } else {
                    // Regular shift reminder
                    const dateStr = shift.date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
                    const shiftText = `🏃 <b>Сьогодні (${dateStr}) у тебе зміна в ${shift.location.name}!</b> 📸\nВдалого дня та гарних знімків! ✨`;

                    const tasks = await taskService.getStaffActiveTasks(staff.id);
                    const activeTasksCount = tasks.filter(t => !t.isCompleted).length;
                    const taskSummary = activeTasksCount > 0
                        ? `\n\n🔴 <b>У тебе є активні завдання (${activeTasksCount})!</b>\nПереглянь їх у розділі «Мої завдання». 👇`
                        : "";

                    const pendingParcelsCount = await prisma.parcel.count({
                        where: {
                            locationId: shift.locationId,
                            OR: [
                                { status: { in: ['EXPECTED', 'ARRIVED'] } },
                                { status: 'DELIVERED', deliveryType: 'Address', contentPhotoIds: { isEmpty: true } }
                            ]
                        }
                    });

                    const parcelsSummary = pendingParcelsCount > 0
                        ? `\n\n📦 <b>Забрати посилки: ${pendingParcelsCount} шт!</b>\nВідкрий меню «📦 Посилки локації» та обов'язково забери їх сьогодні.`
                        : "";

                    const firstName = staff.fullName?.split(' ')[1] || staff.fullName?.split(' ')[0] || 'фотографине';
                    const greeting = `👋 <b>Доброго ранку, ${firstName}!</b>\n\nОсь твій робочий хаб на сьогодні:`;

                    const fullText = `${greeting}\n\n${shiftText}${taskSummary}${parcelsSummary}`;

                    await bot.api.sendMessage(Number(telegramId), fullText, {
                        parse_mode: "HTML",
                        reply_markup: staffHubMenu,
                        disable_notification: true
                    });
                    logger.info({ telegramId }, "[Cron] Shift reminder sent.");
                }
            } catch (err) {
                logger.error({ err, telegramId }, "[Cron] Failed to send shift reminder.");
            }
        }

        // Notify mentors about today's onboarding candidates
        if (onboardingCandidates.length > 0) {
            const { MENTOR_IDS } = await import("../config.js");
            for (const cand of onboardingCandidates) {
                const locName = cand.location?.name || cand.city || "—";
                const shiftTime = cand.firstShiftTime || "";

                let text = `🎓 <b>Onboarding Today</b>\n\n` +
                    `👤 ${cand.fullName}\n` +
                    `📍 ${locName}\n`;
                if (shiftTime) text += `🕐 ${shiftTime}\n`;
                text += `\nPlease stay available online during the shift.`;

                const kb = new InlineKeyboard().text("👤 Profile", `mentor_onboarding_details_${cand.id}`);
                for (const mentorId of MENTOR_IDS) {
                    await bot.api.sendMessage(mentorId, text, { parse_mode: "HTML", reply_markup: kb }).catch(() => { });
                }
                logger.info({ candId: cand.id }, "[Cron] Onboarding reminder sent to mentors.");
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
