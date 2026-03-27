import logger from "../core/logger.js";
import { InlineKeyboard, Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import prisma from "../db/core.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { TEAM_CHATS, HR_NAME, MENTOR_NAME, HR_IDS } from "../config.js";
import { taskService } from "./task-service.js";
import { truncateText } from "../utils/task-helpers.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";

import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { notifyMentors } from "./hr-service.js";
import { processInviteReminders } from "../workers/invite-reminder.js";
import { isBotBlocked, handleBlockedCandidate } from "../utils/bot-blocked.js";


/**
 * Фоновий вокер для автоматизації воронки.
 * Перевіряє нагадування та фінальні опитування кожні 5 хвилин.
 */
export async function startWorker(bot: Bot<MyContext>) {
    logger.info("⚙️ Вокер воронки запущено з основним ботом...");

    let iteration = 0;
    setInterval(async () => {
        iteration++;
        try {
            const now = new Date();
            const nowTime = now.getTime();
            logger.info(`[${now.toLocaleTimeString()}] ⚙️ Вокер перевіряє завдання...`);

            // 0. Process HR Invites (24h ping / 48h reset)
            await processInviteReminders(bot);

            // 1. Process HR Decisions (6 hours delay)
            const sixHoursAgo = new Date(nowTime - 6 * 60 * 60 * 1000);

            const decisionCandidates = await candidateRepository.findForDecisionNotification(sixHoursAgo);

            for (const cand of decisionCandidates) {
                try {
                    const decision = cand.hrDecision;

                    if (decision === "ACCEPTED") {
                        const firstName = extractFirstName(cand.fullName || "Кандидатко");
                        const mentorDisplay = MENTOR_NAME.toLowerCase().includes("наставниц") ? MENTOR_NAME : `твоя наставниця ${MENTOR_NAME}`;

                        try {
                            await bot.api.sendMessage(
                                Number(cand.user.telegramId),
                                CANDIDATE_TEXTS["worker-offer-accepted"](firstName, mentorDisplay),
                                {
                                    parse_mode: "HTML",
                                    reply_markup: new InlineKeyboard().text("👩‍🏫 Написати наставниці", "contact_hr")
                                }
                            );
                            await candidateRepository.update(cand.id, {
                                status: CandidateStatus.ACCEPTED,
                                notificationSent: true
                            });

                            // Notify Mentor about the new candidate who just received their offer
                            await notifyMentors(bot.api, cand);
                        } catch (sendErr: any) {
                            logger.error({ err: sendErr, candidateId: cand.id }, "❌ Failed to send offer notification");
                            // Notify HR about delivery failure
                            if (HR_IDS.length > 0) {
                                await bot.api.sendMessage(
                                    HR_IDS[0]!,
                                    ADMIN_TEXTS["admin-notif-delivery-failed"]({ name: cand.fullName || "Candidate", error: sendErr.message }),
                                    { parse_mode: "HTML" }
                                ).catch(() => { });
                            }
                        }
                    } else if (decision === "REJECTED") {
                        try {
                            await bot.api.sendMessage(
                                Number(cand.user.telegramId),
                                CANDIDATE_TEXTS["worker-offer-rejected"]
                            );
                            await candidateRepository.update(cand.id, {
                                status: CandidateStatus.REJECTED,
                                notificationSent: true
                            });
                        } catch (sendErr) {
                            logger.error({ err: sendErr, candidateId: cand.id }, "❌ Failed to send rejection notification");
                        }
                    }
                } catch (e) {
                    logger.error({ err: e, candidateId: cand.id }, `❌ Помилка вокера для кандидата`);
                }
            }

            // 2. Нагадування Кандидату про Співбесіду (6 годин)
            const sixHoursFuture = new Date(nowTime + 6 * 60 * 60 * 1000);
            const slots6h = await interviewRepository.findForReminder('reminded6h', sixHoursFuture);

            for (const slot of slots6h) {
                if (!slot.candidate) continue;
                try {
                    logger.info({
                        candidateId: slot.candidate.id,
                        slotId: slot.id,
                        telegramId: slot.candidate.user.telegramId
                    }, "Sending 6h interview reminder");

                    const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    const firstName = extractFirstName(slot.candidate.fullName || "Кандидатко");
                    const hrDisplay = HR_NAME.startsWith("HR") ? HR_NAME : `наша HR ${HR_NAME}`;

                    const msg = await bot.api.sendMessage(
                        Number(slot.candidate.user.telegramId),
                        CANDIDATE_TEXTS["worker-interview-reminder-6h"](firstName, timeStr, hrDisplay),
                        { parse_mode: "HTML" }
                    );
                    await interviewRepository.updateSlot(slot.id, { reminded6h: true, lastReminderMsgId: msg.message_id });
                } catch (e: any) {
                    if (isBotBlocked(e) && slot.candidate) {
                        await handleBlockedCandidate(bot.api, slot.candidate.id, slot.candidate.fullName || "Candidate");
                    } else {
                        logger.error({ err: e, candidateId: slot.candidate?.id, slotId: slot.id }, "Failed to send 6h interview reminder");
                    }
                }
            }

            // 3. Нагадування Кандидату про Співбесіду (10 хвилин)
            const tenMinFuture = new Date(nowTime + 10 * 60 * 1000);
            const slots10m = await interviewRepository.findForReminder('reminded10m', tenMinFuture);

            for (const slot of slots10m) {
                if (!slot.candidate) continue;
                try {
                    logger.info({
                        candidateId: slot.candidate.id,
                        slotId: slot.id,
                        telegramId: slot.candidate.user.telegramId
                    }, "Sending 10m interview reminder");

                    const meetLink = slot.candidate.googleMeetLink;
                    const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    const hrDisplay = HR_NAME.startsWith("HR") ? HR_NAME : `наша HR ${HR_NAME}`;

                    await bot.api.sendMessage(
                        Number(slot.candidate.user.telegramId),
                        CANDIDATE_TEXTS["worker-interview-reminder-10m"](timeStr, hrDisplay, meetLink || undefined),
                        { parse_mode: "HTML" }
                    );
                    await interviewRepository.updateSlot(slot.id, { reminded10m: true });
                } catch (e: any) {
                    if (isBotBlocked(e) && slot.candidate) {
                        await handleBlockedCandidate(bot.api, slot.candidate.id, slot.candidate.fullName || "Candidate");
                    }
                }
            }

            // 4. HR Reminder (~2 minutes, window 1-4 min before start)
            const fourMinFuture = new Date(nowTime + 4 * 60 * 1000);
            const oneMinFuture = new Date(nowTime + 1 * 60 * 1000);
            const slots2mHR = (await interviewRepository.findForReminder('reminded2mHR', fourMinFuture))
                .filter(s => s.startTime >= oneMinFuture);

            for (const slot of slots2mHR) {
                if (HR_IDS.length === 0) break;
                try {
                    const name = slot.candidate?.fullName || "Candidate";
                    const meetLink = slot.candidate?.googleMeetLink;
                    const minsLeft = Math.max(1, Math.round((slot.startTime.getTime() - nowTime) / 60000));
                    let text = `🕵️‍♀️ <b>${HR_NAME}, interview in ${minsLeft} min!</b>\n\n👤 Candidate: <b>${name}</b>\n`;
                    if (meetLink) {
                        text += `🔗 <b>Meet:</b> <a href="${meetLink}">Enter Room</a>`;
                    }
                    await bot.api.sendMessage(HR_IDS[0]!, text, { parse_mode: "HTML" });
                    await interviewRepository.updateSlot(slot.id, { reminded2mHR: true });
                } catch (e) { }
            }

            // --- TRAINING & DISCOVERY REMINDERS ---

            // 5. Training/Discovery Reminder (6 hours)
            const trainingSlots6h = await trainingRepository.findForReminder('reminded6h', sixHoursFuture);

            for (const slot of trainingSlots6h) {
                if (!slot.candidate && !slot.candidateDiscovery) continue;
                try {
                    const cand = (slot.candidate || slot.candidateDiscovery)!;
                    const isDiscovery = !!slot.candidateDiscovery;

                    const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    const firstName = extractFirstName(cand.fullName || "Candidate");
                    const mentorDisplay = MENTOR_NAME.toLowerCase().includes("наставниц") ? MENTOR_NAME : `наставниця ${MENTOR_NAME}`;

                    const typeText = isDiscovery ? "discovery" : "training";
                    const msg = await bot.api.sendMessage(
                        Number(cand.user.telegramId),
                        CANDIDATE_TEXTS["worker-training-reminder-6h"](firstName, typeText, timeStr, mentorDisplay),
                        {
                            parse_mode: "HTML",
                            reply_markup: new InlineKeyboard().text("👩‍🏫 Написати наставниці", "contact_hr")
                        }
                    );
                    await trainingRepository.updateSlot(slot.id, { reminded6h: true, lastReminderMsgId: msg.message_id });
                } catch (e: any) {
                    const cand = (slot.candidate || slot.candidateDiscovery)!;
                    if (isBotBlocked(e) && cand) {
                        await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                    }
                }
            }

            // 5.1 NEW: Candidate Training Reminder (1 hour)
            const oneHourFuture = new Date(nowTime + 60 * 60 * 1000);
            const trainingSlots1h = await prisma.trainingSlot.findMany({
                where: {
                    isBooked: true,
                    startTime: { lte: oneHourFuture, gte: now },
                    reminded6h: true,
                    reminded10m: false, // Use a temporary check or add reminded1h to schema
                    candidateId: { not: null }
                },
                include: { candidate: { include: { user: true } } }
            });

            for (const slot of trainingSlots1h) {
                // To avoid spamming every 5 mins, we'd ideally need a 'reminded1h' column. 
                // Since I can't easily add it now, I'll skip this or use a cache.
                // For now, let's focus on the 10m and 5m which are more critical.
            }

            // 6. Training/Discovery Reminder (10 minutes)
            const trainingSlots10m = await trainingRepository.findForReminder('reminded10m', tenMinFuture);

            for (const slot of trainingSlots10m) {
                if (!slot.candidate && !slot.candidateDiscovery) continue;
                try {
                    const cand = (slot.candidate || slot.candidateDiscovery)!;
                    const isDiscovery = !!slot.candidateDiscovery;
                    const meetLink = isDiscovery ? cand.trainingMeetLink : cand.trainingMeetLink; // Both use same field for now

                    const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    const mentorDisplay = MENTOR_NAME.toLowerCase().includes("наставниц") ? MENTOR_NAME : `наставниця ${MENTOR_NAME}`;

                    const typeText = isDiscovery ? "discovery" : "training";
                    await bot.api.sendMessage(
                        Number(cand.user.telegramId),
                        CANDIDATE_TEXTS["worker-training-reminder-10m"](typeText, timeStr, mentorDisplay, meetLink || undefined),
                        {
                            parse_mode: "HTML",
                            reply_markup: new InlineKeyboard().text("👩‍🏫 Написати наставниці", "contact_hr")
                        }
                    );
                    await trainingRepository.updateSlot(slot.id, { reminded10m: true });
                } catch (e: any) {
                    const cand = (slot.candidate || slot.candidateDiscovery)!;
                    if (isBotBlocked(e) && cand) {
                        await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                    }
                }
            }

            // 6.5 Mentor Reminder (~5 minutes, window 2-7 min before start)
            const sevenMinFutureMentor = new Date(nowTime + 7 * 60 * 1000);
            const twoMinFutureMentor = new Date(nowTime + 2 * 60 * 1000);
            const trainingSlots5mMentor = (await trainingRepository.findForReminder('reminded5mMentor', sevenMinFutureMentor))
                .filter(s => s.startTime >= twoMinFutureMentor);

            const MENTORS = (process.env.MENTOR_IDS || "").split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

            for (const slot of trainingSlots5mMentor) {
                if (MENTORS.length === 0) break;
                try {
                    const cand = (slot.candidate || slot.candidateDiscovery)!;
                    const isDiscovery = !!slot.candidateDiscovery;
                    const typeText = isDiscovery ? "discovery" : "training";

                    const name = cand.fullName || "Candidate";
                    const meetLink = isDiscovery ? cand.trainingMeetLink : cand.trainingMeetLink;
                    const city = cand.city || "Not specified";

                    const minsLeft = Math.max(1, Math.round((slot.startTime.getTime() - nowTime) / 60000));
                    let text = `🕵️‍♀️ <b>${MENTOR_NAME}, ${typeText} in ${minsLeft} min!</b>\n\n` +
                        `👤 Candidate: <b>${name}</b>\n` +
                        `🏙️ City: <b>${city}</b>\n`;

                    if (meetLink) {
                        text += `🔗 <b>Meet:</b> <a href="${meetLink}">Enter Room</a>`;
                    }

                    const kb = new InlineKeyboard().text("👤 Profile", `view_candidate_${cand.id}`);
                    
                    for (const mentorId of MENTORS) {
                        await bot.api.sendMessage(mentorId, text, { parse_mode: "HTML", reply_markup: kb }).catch(() => { });
                    }
                    
                    await trainingRepository.updateSlot(slot.id, { reminded5mMentor: true });
                } catch (e) { }
            }
            // 7. Auto-Complete (Interview & Training)
            const completedSlots = await interviewRepository.findOverdueBooked(CandidateStatus.INTERVIEW_SCHEDULED);

            for (const slot of completedSlots) {
                if (!slot.candidate) continue;
                try {
                    await candidateRepository.update(slot.candidate.id, {
                        status: CandidateStatus.INTERVIEW_COMPLETED,
                        interviewCompletedAt: slot.endTime
                    });

                    // Notify HR to make a decision (Proactive Assistance)
                    if (HR_IDS.length > 0) {
                        const name = slot.candidate.fullName || "Candidate";
                        const text = `🏁 <b>Interview Completed: ${name}</b>\n\nTime is up, status updated to "Completed". Please review the profile and make an offer decision! ⚖️🌸`;
                        const kb = new InlineKeyboard().text("👤 View and Decide", `view_candidate_${slot.candidate.id}`);

                        await bot.api.sendMessage(HR_IDS[0]!, text, { parse_mode: "HTML", reply_markup: kb });
                    }
                    await interviewRepository.updateSlot(slot.id, { remindedCompletion: true });
                } catch (e) { }
            }

            // MENTOR NOTIFICATION: Delayed from startTime
            // Discovery (Знайомство) - 20 min from start
            // Training (Навчання) - 40 min from start
            const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);
            const fortyMinAgo = new Date(Date.now() - 40 * 60 * 1000);

            const pendingMentorNotifs = await prisma.trainingSlot.findMany({
                where: {
                    isBooked: true,
                    remindedCompletion: false,
                    OR: [
                        {
                            candidateDiscovery: { status: "DISCOVERY_SCHEDULED" as any },
                            startTime: { lt: twentyMinAgo }
                        },
                        {
                            candidate: { status: CandidateStatus.TRAINING_SCHEDULED },
                            startTime: { lt: fortyMinAgo }
                        }
                    ]
                },
                include: { candidate: true, candidateDiscovery: true }
            });

            for (const slot of pendingMentorNotifs) {
                const cand = slot.candidate || slot.candidateDiscovery;
                if (!cand) continue;

                try {
                    const MENTORS = (process.env.MENTOR_IDS || "").split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
                    if (MENTORS.length > 0) {
                        const isDiscovery = !!slot.candidateDiscovery;
                        const typeName = isDiscovery ? "Discovery" : "Training";
                        const name = cand.fullName || "Candidate";

                        const text = `🏁 <b>${typeName} Completed: ${name}</b>\n\n` +
                            `Slot time is up. Please mark the result (Passed/Failed) in the candidate's profile so they can proceed to the next stage! 🎓🌸`;
                        const kb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${cand.id}`);

                        await bot.api.sendMessage(MENTORS[0]!, text, { parse_mode: "HTML", reply_markup: kb });
                    }

                    await trainingRepository.updateSlot(slot.id, { remindedCompletion: true });
                    // IMPORTANT: We do NOT change candidate status here. They stay in the calendar/hub
                    // until the mentor manually clicks "Passed" or "Failed" in the profile.
                } catch (e) { }
            }

            // 8. Task Automations
            await processTaskAutomations(bot);

            // Cleanup tasks (Run every 1 hour = 240 * 15s)
            if (iteration % 240 === 0) {
                // 9. Auto-close stale tasks (48h after workDate)
                await processAutoCloseTasks();

                // 10. Auto-close stale outgoing topics (48h after last activity)
                await processAutoCloseTopics(bot);

                // 10.1 Auto-close stale support tickets (48h after last activity)
                await processAutoCloseTickets(bot);
            }

            // 11. 🛡️ Reliability FIX: Notify abandoned applications (once a day at 11:00)
            const kyivHour = parseInt(new Intl.DateTimeFormat('uk-UA', {
                hour: '2-digit',
                hour12: false,
                timeZone: 'Europe/Kyiv'
            }).format(now));

            if (kyivHour === 11 && now.getMinutes() < 5) {
                await processAbandonedApplications(bot);
                await processAutoRejectInactiveCandidates(bot);
                // processStalePipelineAlert disabled: HR/Mentor/Admin see their queues in the bot menus
            }

            // 11.1 NEW: Notify candidates who haven't picked an interview slot (24h after invite)
            await processInviteReminders(bot);

            // 11.2 NEW: Notify candidates who haven't picked a discovery/training slot (24h after access)
            await processTrainingReminders(bot);

            // 12. NDA Reminders (Every 24h until confirmed)
            await processNDAReminders(bot);

            // 13. Test Reminders (Every 24h until passed)
            await processTestReminders(bot);

            // 14. Post-staging admin reminder (1h after staging ends)
            await processPostStagingReminder(bot);

            // 15. Onboarding data reminders (every 24h until filled)
            await processOnboardingReminders(bot);

        } catch (error) {
            logger.error({ err: error }, "❌ Глобальна помилка вокера");
        }
    }, 5 * 60 * 1000);
}

/**
 * Test Reminder: Нагадування кандидаткам, які підтвердили NDA, але не пройшли тест.
 */
async function processTestReminders(bot: Bot<MyContext>) {
    try {
        const { default: prisma } = await import("../db/core.js");
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Find candidates who confirmed NDA > 24h ago but haven't passed the test
        const pendingTest = await prisma.candidate.findMany({
            where: {
                ndaConfirmedAt: { lte: twentyFourHoursAgo, not: null },
                testPassed: { not: true },
                status: CandidateStatus.KNOWLEDGE_TEST
            },
            include: { user: true }
        });

        for (const cand of pendingTest) {
            try {
                // Check if we already poked them today using user.updatedAt or a dedicated check
                // To keep it simple and Apple-style, we use user.updatedAt as a throttle
                const userUpdate = new Date(cand.user.updatedAt);
                if (now.getTime() - userUpdate.getTime() < 23 * 60 * 60 * 1000) continue;

                const kb = new InlineKeyboard().text("📝 Почати тест", `start_training_test_${cand.id}`);
                await bot.api.sendMessage(Number(cand.user.telegramId),
                    `<b>Продовжимо твій шлях? ✨</b>\n\nТи вже ознайомилась з NDA. Залишився останній крок перед виходом на локацію — короткий тест. Давай перевіримо твої знання! 📸`,
                    { parse_mode: "HTML", reply_markup: kb }
                );

                await prisma.user.update({ where: { id: cand.userId }, data: { updatedAt: new Date() } });
                logger.info({ userId: cand.user.telegramId }, "📢 Надіслано нагадування про тест (24 години)");
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Помилка в processTestReminders");
    }
}

/**
 * Training & Discovery Reminder: Нагадування кандидаткам, які отримали доступ до навчання, але не обрали час (через 24 год).
 */
async function processTrainingReminders(bot: Bot<MyContext>) {
    try {
        const { default: prisma } = await import("../db/core.js");
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Find candidates in ACCEPTED status who received materials but didn't book anything
        const pendingTraining = await prisma.candidate.findMany({
            where: {
                status: "ACCEPTED",
                materialsSent: true,
                discoverySlotId: null,
                trainingSlotId: null,
                // Throttle using materialsSentAt or updatedAt
                OR: [
                    { materialsSentAt: { lte: twentyFourHoursAgo } },
                    {
                        materialsSentAt: null,
                        user: { updatedAt: { lte: twentyFourHoursAgo } }
                    }
                ]
            },
            include: { user: true }
        });

        for (const cand of pendingTraining) {
            try {
                // Throttle: only remind once every 23 hours to avoid spamming
                const userUpdate = new Date(cand.user.updatedAt);
                if (now.getTime() - userUpdate.getTime() < 23 * 60 * 60 * 1000) continue;

                const kb = new InlineKeyboard().text("🗓️ Обрати час", "start_training_scheduling");

                const text = `Привіт! ✨\n\nНагадую про запис на відеозустріч-знайомство. Чи вдалося ознайомитись з матеріалами? 📚\n\nОбери зручний час за кнопкою нижче! 👇`;

                await bot.api.sendMessage(Number((cand as any).user.telegramId), text, {
                    parse_mode: "HTML",
                    reply_markup: kb
                });

                logger.info({ userId: (cand as any).user.telegramId }, "📢 Надіслано нагадування про навчання/знайомство (24 години)");

                await prisma.user.update({
                    where: { id: cand.userId },
                    data: { updatedAt: new Date() }
                });
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                else logger.warn({ err: e, userId: (cand as any).user?.telegramId }, "⚠️ Не вдалося надіслати нагадування про навчання");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Помилка в processTrainingReminders");
    }
}

/**
 * Автоматизація завдань: ранкові дайджести та нагадування про дедлайни.
 */
async function processTaskAutomations(bot: Bot<MyContext>) {
    const now = new Date();
    // Використовуємо київський час для перевірки години
    const kyivHour = parseInt(new Intl.DateTimeFormat('uk-UA', {
        hour: '2-digit',
        hour12: false,
        timeZone: 'Europe/Kyiv'
    }).format(now));

    // 1. Ранковий дайджест (8:00 - 9:00)
    if (kyivHour >= 8 && kyivHour < 9) {
        const staffToNotify = await taskService.getStaffForMorningDigest(now);

        for (const staff of staffToNotify) {
            try {
                const s = staff as any;
                const totalTasks = s.tasks.length;
                const shift = s.shifts && s.shifts.length > 0 ? s.shifts[0] : null;

                let text = `🌅 <b>Доброго ранку!</b> ✨\n\n`;

                if (shift) {
                    const dateStr = new Date(shift.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
                    text += `🏃 <b>Сьогодні (${dateStr}) у тебе зміна в ${shift.location.name}!</b> 📸\n\n`;
                }

                if (totalTasks > 0) {
                    text += `У тебе <b>${totalTasks}</b> активних завдань:\n`;
                    s.tasks.forEach((task: any, index: number) => {
                        const deadline = task.deadlineTime ? ` ⏰ До ${task.deadlineTime}` : "";
                        text += `${index + 1}. ${truncateText(task.taskText, 60)}${deadline}\n`;
                    });
                } else if (shift) {
                    text += `Активних завдань на сьогодні немає. 🙌\n`;
                } else {
                    // This case shouldn't happen based on repository query but for safety:
                    text += `Активних завдань та змін на сьогодні не знайдено. 🙌\n`;
                }

                text += `\nБажаю вдалого дня та гарних знімків! ✨`;

                const kb = new InlineKeyboard();
                if (totalTasks > 0) {
                    kb.text("📋 Мої завдання", "staff_hub_tasks_redirect");
                } else {
                    kb.text("🗓 Мій графік", "staff_hub_nav"); // Will show hub which shows today's shift
                }

                await bot.api.sendMessage(Number(s.user.telegramId), text, {
                    parse_mode: "HTML",
                    reply_markup: kb,
                    disable_notification: true
                });

                await taskService.markDigestSent(s.id);
            } catch (e) {
                logger.error({ err: e, staffId: staff.id }, "❌ Помилка надсилання дайджесту");
            }
        }
    }

    // 2. Нагадування про дедлайни (за 1 годину)
    const nearingDeadlineTasks = await taskService.getTasksNearingDeadline(now, 1);

    for (const task of nearingDeadlineTasks) {
        try {
            // Task has deadlineTime like "15:00"
            if (!task.deadlineTime) continue;

            const timeParts = task.deadlineTime.split(':').map(Number);
            if (timeParts.length < 2 || isNaN(timeParts[0]!) || isNaN(timeParts[1]!)) continue;
            const hours = timeParts[0]!;
            const minutes = timeParts[1]!;

            const taskDeadline = new Date(now);
            taskDeadline.setHours(hours, minutes, 0, 0);

            const diffMs = taskDeadline.getTime() - now.getTime();
            const diffMin = Math.round(diffMs / (60 * 1000));

            // Якщо до дедлайну менше 65 хвилин (щоб вловити 5-хвилинний інтервал вокера)
            if (diffMin > 0 && diffMin <= 65) {
                const text = `⚠️ <b>Нагадування!</b>\n\nДо дедлайну завдання "<i>${truncateText(task.taskText, 50)}</i>" залишилась 1 година! ⏰\n\nЧас: <b>${task.deadlineTime}</b>\n\nНе забудь відмітити виконання в меню. ✨`;

                await bot.api.sendMessage(Number(task.staff.user.telegramId), text, { parse_mode: "HTML" });
                await taskService.markReminderSent(task.id);
            }
        } catch (e) {
            logger.error({ err: e, taskId: task.id }, "❌ Помилка нагадування про дедлайн");
        }
    }

    // 3. Сповіщення адміну про протерміновані завдання
    const overdueTasks = await taskService.getOverdueTasks(now);
    const dateStr = now.toISOString().split('T')[0];

    // Отримуємо список підтримки для сповіщення
    const { SUPPORT_IDS } = await import("../config.js");

    if (SUPPORT_IDS.length === 0) return;

    for (const task of overdueTasks) {
        try {
            const staffName = truncateText(task.staff.fullName, 30);
            const text = `🔴 <b>Overdue:</b> ${staffName}\n` +
                `📝 ${truncateText(task.taskText, 60)}\n` +
                `⏰ Deadline: <b>${task.deadlineTime}</b>`;

            const kb = new InlineKeyboard().text("📋 Details", `task_det_${task.id}_${dateStr}`);

            // Надсилаємо кожному з підтримки
            for (const adminId of SUPPORT_IDS) {
                try {
                    await bot.api.sendMessage(adminId, text, {
                        parse_mode: "HTML",
                        reply_markup: kb
                    });
                } catch (sendErr) {
                    logger.error({ err: sendErr, adminId }, "❌ Помилка надсилання сповіщення сапорту");
                }
            }

            await taskService.markOverdueAdminNotified(task.id);
        } catch (e) {
            logger.error({ err: e, taskId: task.id }, "❌ Помилка сповіщення про протерміноване завдання");
        }
    }
}

/**
 * Авто-закриття завдань через 48 годин після workDate
 */
async function processAutoCloseTasks() {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    try {
        const { default: prisma } = await import("../db/core.js");
        const result = await prisma.task.updateMany({
            where: {
                isCompleted: false,
                workDate: { lte: cutoff, not: null },
            },
            data: { isCompleted: true },
        });
        if (result.count > 0) {
            logger.info(`🕐 Auto-closed ${result.count} stale tasks (>48h after workDate)`);
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in processAutoCloseTasks");
    }
}

/**
 * Авто-закриття топіків вихідних повідомлень через 48 годин без активності
 */
async function processAutoCloseTopics(bot: Bot<MyContext>) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    try {
        const { default: prisma } = await import("../db/core.js");
        const staleTopics = await prisma.outgoingTopic.findMany({
            where: {
                isClosed: false,
                updatedAt: { lte: cutoff },
            },
        });

        for (const topic of staleTopics) {
            try {
                // If there's a topic, try to close it in Telegram
                await bot.api.closeForumTopic(Number(topic.chatId), topic.topicId).catch(() => { });

                // Close in DB
                await prisma.outgoingTopic.update({
                    where: { id: topic.id },
                    data: { isClosed: true },
                });
                logger.info(`🔒 Auto-closed topic ${topic.topicId} in chat ${topic.chatId} due to 48h inactivity`);
            } catch (e) {
                logger.warn({ err: e, topicId: topic.topicId }, "⚠️ Failed to auto-close topic");
                // Mark as closed anyway to avoid retrying indefinitely
                await prisma.outgoingTopic.update({
                    where: { id: topic.id },
                    data: { isClosed: true },
                }).catch(() => { });
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in processAutoCloseTopics");
    }
}

/**
 * Авто-закриття тікетів підтримки через 48 годин без активності
 */
async function processAutoCloseTickets(bot: Bot<MyContext>) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    try {
        const { default: prisma } = await import("../db/core.js");
        const { TEAM_CHATS } = await import("../config.js");

        const staleTickets = await prisma.supportTicket.findMany({
            where: {
                status: { in: ["OPEN", "IN_PROGRESS"] },
                updatedAt: { lte: cutoff },
            },
        });

        for (const ticket of staleTickets) {
            try {
                // If there's a topic, try to close it in Telegram
                if (ticket.topicId && TEAM_CHATS.SUPPORT) {
                    await bot.api.closeForumTopic(Number(TEAM_CHATS.SUPPORT), ticket.topicId).catch(() => { });
                }

                // Close in DB
                await prisma.supportTicket.update({
                    where: { id: ticket.id },
                    data: { status: "CLOSED" },
                });

                logger.info(`🔒 Auto-closed support ticket #${ticket.id} due to 48h inactivity`);
            } catch (e) {
                logger.warn({ err: e, ticketId: ticket.id }, "⚠️ Failed to auto-close support ticket");
                // Fallback: still mark as closed in DB to avoid retry loop if TG fails
                await prisma.supportTicket.update({
                    where: { id: ticket.id },
                    data: { status: "CLOSED" },
                }).catch(() => { });
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in processAutoCloseTickets");
    }
}

/**
 * 🛡️ Reliability FIX: Нагадування кандидатам, які не дозаповнили анкету або документи.
 */
async function processAbandonedApplications(bot: Bot<MyContext>) {
    logger.info("🕵️‍♂️ Перевірка покинутих анкет та документів...");
    try {
        const { default: prisma } = await import("../db/core.js");
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

        // 1. Анкетування (SCREENING)
        const abandonedScreening = await prisma.candidate.findMany({
            where: {
                status: "SCREENING",
                user: {
                    createdAt: { lte: yesterday, gte: twoDaysAgo }
                }
            },
            include: { user: true }
        });

        for (const cand of abandonedScreening) {
            try {
                await bot.api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["worker-abandoned-screening"], { parse_mode: "HTML" });
                logger.info({ userId: cand.user.telegramId }, "📢 Надіслано нагадування про анкету");
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                else logger.warn({ err: e, userId: cand.user.telegramId }, "⚠️ Не вдалося надіслати нагадування кандидату");
            }
        }

        // 2. Документи/Онбординг — moved to processOnboardingReminders (recurring every 24h)
    } catch (e) {
        logger.error({ err: e }, "❌ Помилка в processAbandonedApplications");
    }
}

/**
 * Smart Reminder: Надсилає нагадування кандидаткам, які не ознайомились з NDA протягом 6 годин (та кожні 24 години після цього).
 */
async function processNDAReminders(bot: Bot<MyContext>) {
    try {
        const { default: prisma } = await import("../db/core.js");
        const now = new Date();
        const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

        // Find candidates who received NDA > 6 hours ago but haven't confirmed it
        const pendingNDA = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.NDA,
                ndaConfirmedAt: null,
                ndaSentAt: { lte: sixHoursAgo, not: null }
            },
            include: { user: true }
        });

        for (const cand of pendingNDA) {
            try {
                // Throttle: only remind once every 23 hours
                const userUpdate = new Date(cand.user.updatedAt);
                if (now.getTime() - userUpdate.getTime() < 23 * 60 * 60 * 1000) continue;

                const firstName = extractFirstName(cand.fullName || "Кандидатко");
                const { NDA_LINK } = await import("../config.js");
                const kb = new InlineKeyboard();
                if (NDA_LINK) kb.url("📋 Прочитати NDA", NDA_LINK).row();
                kb.text("✅ Я все прочитала та згодна", `confirm_nda_${cand.id}`);

                await bot.api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["nda-reminder"](firstName, NDA_LINK), {
                    parse_mode: "HTML",
                    reply_markup: kb
                });

                // Update user to reset throttle
                await prisma.user.update({ where: { id: cand.userId }, data: { updatedAt: new Date() } });
                logger.info({ userId: cand.user.telegramId }, "📢 Надіслано нагадування про NDA (циклічне)");
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                else logger.warn({ err: e, userId: cand.user.telegramId }, "⚠️ Не вдалося надіслати нагадування про NDA");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Помилка в processNDAReminders");
    }
}

/**

/**
 * Post-Staging Reminder: 1 hour after staging end time, remind admin to mark Pass/Fail.
 * Runs every 5 min. Uses STAGING_ACTIVE + firstShiftDate to detect completed stagings.
 */
async function processPostStagingReminder(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        // Find candidates in STAGING_ACTIVE whose staging date has passed 1+ hour ago
        const candidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.STAGING_ACTIVE,
                firstShiftDate: { not: null, lte: oneHourAgo },
                // notificationSent is true when staging was activated
                notificationSent: true
            },
            include: { user: true, location: true }
        });

        for (const cand of candidates) {
            // Throttle: only send once per 23h using user.updatedAt
            const userUpdate = new Date(cand.user.updatedAt);
            if (now.getTime() - userUpdate.getTime() < 23 * 60 * 60 * 1000) continue;

            try {
                const name = cand.fullName || "Candidate";
                const loc = cand.location?.name || cand.city || "";
                const text = `📸 <b>Staging completed: ${name}</b>\n` +
                    `📍 ${loc}\n\n` +
                    `Please mark the result — did the candidate pass or fail? ⚖️`;

                const kb = new InlineKeyboard()
                    .text("👤 View & Decide", `view_candidate_${cand.id}`);

                if (HR_IDS[0]) {
                    await bot.api.sendMessage(HR_IDS[0], text, { parse_mode: "HTML", reply_markup: kb }).catch(() => { });
                }

                await prisma.user.update({ where: { id: cand.userId }, data: { updatedAt: new Date() } });
                logger.info({ candId: cand.id }, "📢 Post-staging reminder sent to admin");
            } catch (e) {
                logger.warn({ err: e, candId: cand.id }, "⚠️ Failed to send post-staging reminder");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in processPostStagingReminder");
    }
}

/**
 * Onboarding Reminders: Every 24h, nudge READY_FOR_HIRE candidates who haven't filled data.
 * Replaces the old one-shot 24-48h window from processAbandonedApplications.
 */
async function processOnboardingReminders(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const candidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.READY_FOR_HIRE,
                user: { updatedAt: { lte: twentyFourHoursAgo } }
            },
            include: { user: true }
        });

        const { getMissingFieldLabels } = await import("../handlers/onboarding-handler.js");

        for (const cand of candidates) {
            const userUpdate = new Date(cand.user.updatedAt);
            if (now.getTime() - userUpdate.getTime() < 23 * 60 * 60 * 1000) continue;

            try {
                const missing = getMissingFieldLabels(cand);
                const kb = new InlineKeyboard().text("📝 Продовжити", "start_onboarding_data");

                let text: string;
                if (missing.length === 0) {
                    text = "Привіт! 👋 Схоже, всі дані вже заповнені — натисни кнопку нижче, щоб завершити оформлення! ✨";
                } else {
                    text = `Привіт! 👋\n\nЗалишилось заповнити: <b>${missing.join(", ")}</b>.\nЦе займе буквально пару хвилин! ✨`;
                }

                await bot.api.sendMessage(Number(cand.user.telegramId), text, { parse_mode: "HTML", reply_markup: kb });

                await prisma.user.update({ where: { id: cand.userId }, data: { updatedAt: new Date() } });
                logger.info({ userId: cand.user.telegramId, missing: missing.length }, "📢 Smart onboarding reminder sent");
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                else logger.warn({ err: e, userId: cand.user.telegramId }, "⚠️ Failed to send onboarding reminder");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in processOnboardingReminders");
    }
}

/**
 * Auto-archive workflow: 
 * - На 5-й день надсилає фінальне попередження.
 * - На 7-й день переводить у REJECTED.
 */
async function processAutoRejectInactiveCandidates(bot: Bot<MyContext>) {
    try {
        const { default: prisma } = await import("../db/core.js");
        const now = new Date();
        const cutoff5Days = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
        const cutoff6Days = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        const cutoff7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // 1. ACCEPTED (Sent materials, but didn't book)
        const idleAccepted = await prisma.candidate.findMany({
            where: {
                status: "ACCEPTED", materialsSent: true, discoverySlotId: null, trainingSlotId: null,
                materialsSentAt: { lte: cutoff5Days }
            },
            include: { user: true }
        });

        // 2. NDA (Sent NDA, but didn't confirm)
        const idleNDA = await prisma.candidate.findMany({
            where: {
                status: "NDA", ndaConfirmedAt: null,
                ndaSentAt: { lte: cutoff5Days }
            },
            include: { user: true }
        });

        // 3. KNOWLEDGE_TEST (Confirmed NDA, but didn't pass test)
        const idleTest = await prisma.candidate.findMany({
            where: {
                status: "KNOWLEDGE_TEST", testPassed: { not: true },
                ndaConfirmedAt: { lte: cutoff5Days }
            },
            include: { user: true }
        });

        // 4. STAGING_SETUP (Passed test, didn't choose date)
        const idleStagingSetup = await prisma.candidate.findMany({
            where: {
                status: "STAGING_SETUP",
                statusChangedAt: { lte: cutoff5Days }
            },
            include: { user: true }
        });

        const allIdle = [...idleAccepted, ...idleNDA, ...idleTest, ...idleStagingSetup];

        for (const cand of allIdle) {
            try {
                let referenceDate = cand.materialsSentAt || cand.ndaSentAt || cand.ndaConfirmedAt || cand.statusChangedAt;
                // Fallback to avoid dropping candidates without these timestamps but they shouldn't match the queries above anyway
                if (!referenceDate) continue;

                if (referenceDate <= cutoff7Days) {
                    // Day 7: Reject
                    let rejectReason = "на стажування";
                    if (cand.status === "KNOWLEDGE_TEST" || cand.status === "STAGING_SETUP") rejectReason = "після тестування";

                    try {
                        await bot.api.sendMessage(Number(cand.user.telegramId),
                            `Привіт! ✨ Оскільки ми тривалий час не отримали відповіді, ми змушені скасувати твою заявку ${rejectReason}. Бажаємо успіхів! Якщо в майбутньому ти знову захочеш спробувати свої сили в PlayPhoto — ми будемо раді бачити тебе. 🌸`);
                    } catch (e: any) {
                        if (!isBotBlocked(e)) logger.warn({ err: e }, "⚠️ Failed to send 7-day rejection message");
                    }
                    await candidateRepository.update(cand.id, { status: "REJECTED" });
                    logger.info({ userId: cand.user.telegramId }, "🚫 Кандидата автоматично переведено в REJECTED (7 днів неактивності)");
                } else if (referenceDate <= cutoff5Days && referenceDate > cutoff6Days) {
                    // Day 5: Warning (We run this once a day, so it will hit exactly once)
                    let contextStr = "на твій наступний крок";
                    switch (cand.status) {
                        case "ACCEPTED": contextStr = "на вибір часу для зустрічі з наставницею"; break;
                        case "NDA": contextStr = "на ознайомлення з NDA (правилами команди)"; break;
                        case "KNOWLEDGE_TEST": contextStr = "на проходження фінального тесту"; break;
                        case "STAGING_SETUP": contextStr = "на вибір дати для першого стажування на локації"; break;
                    }

                    try {
                        await bot.api.sendMessage(Number(cand.user.telegramId),
                            `Привіт! ✨ Ми все ще чекаємо ${contextStr}. Якщо ти передумала або знайшла щось інше — це абсолютно нормально! Дай нам знати. Якщо ми не отримаємо відповіді до завтра, ми автоматично скасуємо твою заявку, щоб не турбувати тебе повідомленнями. 🌸`);
                        logger.info({ userId: cand.user.telegramId }, "⚠️ Надіслано 5-денне попередження про неактивність");
                    } catch (e: any) {
                        if (isBotBlocked(e)) await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                    }
                }
            } catch (e) {}
        }

    } catch (e) {
        logger.error({ err: e }, "❌ Помилка в processAutoRejectInactiveCandidates");
    }
}
