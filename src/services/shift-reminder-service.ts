import { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { taskService } from "./task-service.js";
import { CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";
import prisma from "../db/core.js";
import { logBusinessEvent } from "../core/log-events.js";

export async function sendDailyShiftReminders(bot: Bot<MyContext>) {
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
            logger.debug({ date: startOfDay.toISOString() }, "Shift reminders skipped because no shifts were found");
            return;
        }

        // Pre-fetch onboarding candidates (HIRED + isMentorLocked) with firstShiftDate = today
        const onboardingCandidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.HIRED,
                isMentorLocked: true,
                firstShiftDate: { gte: startOfDay, lte: endOfDay },
                user: {
                    is: {
                        staffProfile: {
                            is: {
                                shifts: {
                                    some: { date: { gte: startOfDay, lte: endOfDay } }
                                }
                            }
                        }
                    }
                }
            },
            include: { user: true, location: true }
        });
        const onboardingByUserId = new Map(onboardingCandidates.map(c => [c.userId, c]));

        for (const shift of todayShifts) {
            const staff = shift.staff;
            const telegramId = (staff as any).user?.telegramId;

            if (!telegramId) {
                logger.warn({ staffId: staff.id }, "Shift reminder skipped because staff Telegram ID is missing");
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
                    logger.debug({ telegramId, staffId: staff.id, locationId: shift.locationId }, "First shift onboarding reminder sent");
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
                                { status: 'DELIVERED', contentPhotoIds: { isEmpty: true } }
                            ]
                        }
                    });

                    const parcelsSummary = pendingParcelsCount > 0
                        ? `\n\n📦 <b>Активні посилки на локації: ${pendingParcelsCount} шт.</b>\nВідкрий меню «📦 Посилки локації»: там можуть бути як посилки на забір, так і посилки, де треба дозавантажити фото вмісту.`
                        : "";

                    const firstName = staff.fullName?.split(' ')[1] || staff.fullName?.split(' ')[0] || 'фотографине';
                    const greeting = `👋 <b>Доброго ранку, ${firstName}!</b>\n\nОсь твій робочий хаб на сьогодні:`;

                    const fullText = `${greeting}\n\n${shiftText}${taskSummary}${parcelsSummary}`;
                    const kb = new InlineKeyboard().text("🚀 Відкрити Хаб", "staff_hub_nav");

                    await bot.api.sendMessage(Number(telegramId), fullText, {
                        parse_mode: "HTML",
                        reply_markup: kb,
                        disable_notification: true
                    });
                    logger.debug({ telegramId, staffId: staff.id, locationId: shift.locationId }, "Shift reminder sent");
                }
            } catch (err) {
                logger.error({ err, telegramId, staffId: staff.id, locationId: shift.locationId }, "Shift reminder delivery failed");
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
                logger.debug({ candidateId: cand.id }, "Mentor onboarding reminder sent");
            }
        }
        logBusinessEvent({
            event: "staff.shift_reminders.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "shift-reminder-service",
            operation: "sendDailyShiftReminders",
            safeContext: {
                shiftsCount: todayShifts.length,
                onboardingCandidatesCount: onboardingCandidates.length,
            },
        });
    } catch (error) {
        logger.error({ err: error }, "Shift reminder job failed");
        logBusinessEvent({
            event: "staff.shift_reminders.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "SHIFT_REMINDER_JOB_FAILED",
            module: "shift-reminder-service",
            operation: "sendDailyShiftReminders",
            error,
        });
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
    logBusinessEvent({
        event: "staff.shift_reminder_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "shift-reminder-service",
        operation: "startShiftReminderLoop",
        safeContext: {
            nextRunAt: nextRun.toISOString(),
            delayHours: Number((delay / 1000 / 60 / 60).toFixed(2)),
        },
    });

    setTimeout(() => {
        sendDailyShiftReminders(bot).catch(e => logger.error({ err: e }, "Initial shift reminder run failed"));
        setInterval(() => sendDailyShiftReminders(bot), 24 * 60 * 60 * 1000);
    }, delay);
}
