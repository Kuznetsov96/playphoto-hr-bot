import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { googleCalendar } from "../services/google-calendar.js";
import { ADMIN_IDS, HR_NAME, MENTOR_NAME } from "../config.js";
import { trackMessage, cleanupMessages } from "../utils/cleanup.js";
import { bookingService } from "../services/booking-service.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";

import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import logger from "../core/logger.js";
import { ScreenManager } from "../utils/screen-manager.js";

export const bookingHandlers = new Composer<MyContext>();

bookingHandlers.callbackQuery(/^booking_date_header_.+$/, async (ctx) => {
    await ctx.answerCallbackQuery();
});

bookingHandlers.callbackQuery(/^training_date_header_.+$/, async (ctx) => {
    await ctx.answerCallbackQuery();
});

// --- CALLBACK GUARD: Prevent clicking old buttons ---
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // Actions that are step-specific
    const interviewActions = ["book_slot_", "reschedule_booking_", "start_scheduling", "cancel_booking_", "decline_invite"];
    const trainingActions = ["book_training_slot_", "reschedule_training_", "start_training_scheduling", "cancel_training_"];
    const onboardingActions = ["send_nda_", "start_quiz", "confirm_nda_", "candidate_start_screening"];

    if (![...interviewActions, ...trainingActions, ...onboardingActions].some(a => data.startsWith(a))) {
        return next();
    }

    const telegramId = ctx.from.id;
    const candidate = await candidateRepository.findByTelegramId(telegramId);
    if (!candidate) return next();

    // 1. Interview actions guard
    if (interviewActions.some(a => data.startsWith(a))) {
        const forbiddenStatuses: CandidateStatus[] = [
            CandidateStatus.REJECTED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
            CandidateStatus.ACCEPTED,
            CandidateStatus.DISCOVERY_SCHEDULED,
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.NDA,
            CandidateStatus.KNOWLEDGE_TEST,
            CandidateStatus.STAGING_SETUP,
            CandidateStatus.STAGING_ACTIVE,
            CandidateStatus.READY_FOR_HIRE
        ];
        if (forbiddenStatuses.includes(candidate.status)) {
            await ctx.answerCallbackQuery("⚠️ Ти вже пройшла цей етап! Оновлюю меню... ✨");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
    }

    // 2. Training actions guard
    if (trainingActions.some(a => data.startsWith(a))) {
        const forbiddenStatuses: CandidateStatus[] = [
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
            CandidateStatus.NDA,
            CandidateStatus.KNOWLEDGE_TEST,
            CandidateStatus.STAGING_SETUP,
            CandidateStatus.STAGING_ACTIVE,
            CandidateStatus.READY_FOR_HIRE
        ];
        if (forbiddenStatuses.includes(candidate.status)) {
            await ctx.answerCallbackQuery("⚠️ Твоє навчання вже завершене! Оновлюю меню... ✨");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
    }

    // 3. Screening reset guard (already handled in candidate.ts but good to have here too)
    if (data === "candidate_start_screening") {
        if (candidate.status !== CandidateStatus.SCREENING && candidate.status !== CandidateStatus.REJECTED) {
            await ctx.answerCallbackQuery("⚠️ Ти вже в команді або на етапі відбору! ✨");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
    }

    await next();
});

// 1. Бронювання слоту
bookingHandlers.callbackQuery(/^book_slot_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1] as string;
    const telegramId = ctx.from.id;

    if (bookingLocks.has(telegramId)) {
        return await ctx.answerCallbackQuery("⏳ Зачекай, бронювання вже в процесі...");
    }

    // Idempotency: check if candidate already has a booked interview
    const existingCand = await candidateRepository.findByTelegramId(telegramId);
    if (existingCand?.interviewSlotId) {
        return await ctx.answerCallbackQuery("✅ Ти вже маєш заброньовану співбесіду!");
    }

    bookingLocks.add(telegramId);

    try {
        await ctx.answerCallbackQuery("Бронюємо... ⏳");
        logger.info({ userId: ctx.from.id, slotId }, `📅 [JOURNEY] Booking interview slot`);
        const result = await bookingService.bookInterviewSlot(telegramId, slotId, ctx.from.username);

        const startTime = (result.slot as any).startTime;
        const fullName = (result.slot as any).candidate?.fullName || ctx.from.first_name || "Кандидатко";
        const firstName = extractFirstName(fullName);

        let confirmationText = `✅ Вітаємо, <b>${firstName}</b>! Твій час для співбесіди заброньовано.\n\n📅 Дата: <b>${startTime.toLocaleDateString('uk-UA')}</b>\n⏰ Час: <b>${startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}</b>\n`;

        if (result.googleEvent.meetLink) {
            confirmationText += `📹 Google Meet: <a href="${result.googleEvent.meetLink}">Приєднатися до зустрічі</a>\n\nМожеш зберегти це посилання собі! ✨`;
        } else {
            const hrDisplay = HR_NAME.startsWith("HR") ? HR_NAME : `HR ${HR_NAME}`;
            confirmationText += `\nТвій запис з'явився у нашому графіку. ${hrDisplay} надішле тобі посилання на відеозустріч ближче до часу проведення. До зустрічі! 🌸✨`;
        }

        const kb = new InlineKeyboard()
            .text("🗓️ Перенести", `reschedule_booking_${result.slot.id}`).row()
            .text("❌ Скасувати", `cancel_booking_${result.slot.id}`).row()
            .text("👩‍💼 Написати HR", "contact_hr");

        await cleanupMessages(ctx);
        const confirmationMsg = await ctx.reply(confirmationText, { parse_mode: "HTML", reply_markup: kb });
        trackMessage(ctx, confirmationMsg.message_id);

        const { HR_IDS } = await import("../config.js");
        if (HR_IDS.length > 0) {
            const hrNotifyText = `🆕 <b>New interview appointment!</b>\n\n` +
                `👤 Candidate: <b>${fullName}</b>\n` +
                `📅 Time: <b>${startTime.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>\n\n` +
                `📍 Appointment added to Google Calendar.`;

            const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${(result as any).candidate?.id}`);
            await ctx.api.sendMessage(HR_IDS[0]!, hrNotifyText, { parse_mode: "HTML", reply_markup: hrKb });
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, userId: telegramId }, "Помилка при бронюванні співбесіди");
        if (e.message === "ALREADY_BOOKED") {
            await ctx.answerCallbackQuery("Вибач, цей слот вже зайнятий. 😔");
        } else if (e.message === "UNDERAGE_CANDIDATE") {
            await ctx.answerCallbackQuery("Цей етап доступний лише після 17 років.");
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-underage"]);
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    } finally {
        bookingLocks.delete(telegramId);
    }
});

// 2. Скасування бронювання
bookingHandlers.callbackQuery(/^cancel_booking_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1] as string;

    try {
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        await bookingService.cancelInterviewSlot(slotId);
        // Reset status so candidate doesn't get stuck in INTERVIEW_SCHEDULED without a slot
        if (candidate && candidate.status === CandidateStatus.INTERVIEW_SCHEDULED) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.SCREENING,
                interviewInvitedAt: new Date(),
                notificationSent: true
            });
        }
        await ctx.answerCallbackQuery("Запис скасовано.");
        await ctx.editMessageText("Твій запис скасовано. Якщо захочеш обрати інший час — тисни команду /start або кнопку нижче. 😊", {
            reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_scheduling")
        });

    } catch (e) {
        logger.error({ err: e, slotId, userId: ctx.from.id }, "Помилка при скасуванні співбесіди");
        await ctx.answerCallbackQuery("Сталася помилка.");
    }
});

// 3. Скасування заявки самим кандидатом
bookingHandlers.callbackQuery(/^cancel_application_by_candidate_(.+)$/, async (ctx) => {
    const candidateId = ctx.match[1] as string;
    const telegramId = ctx.from.id;

    try {
        const candidate = await candidateRepository.findById(candidateId);

        if (!candidate || Number(candidate.user.telegramId) !== telegramId) {
            return await ctx.answerCallbackQuery("Це не твоя заявка.");
        }

        await candidateRepository.update(candidateId, {
            status: CandidateStatus.REJECTED,
            notificationSent: true,
            candidateDecision: "NO"
        });

        await ctx.answerCallbackQuery("Заявку скасовано");
        await ctx.editMessageText("Зрозуміли, дякуємо, що попередила! 🌸\n\nБажаємо тобі успіхів у пошуках і всього найкращого! ✨");
    } catch (e) {
        logger.error({ err: e, candidateId, userId: telegramId }, "Помилка при самостійному скасуванні заявки");
        await ctx.answerCallbackQuery("Помилка при скасуванні.");
    }
});

// 4. Перенесення співбесіди
bookingHandlers.callbackQuery(/^reschedule_booking_(.+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery("Обирай новий час!");

        const slots = await interviewRepository.findActiveSlots();

        const keyboard = new InlineKeyboard();
        slots.slice(0, 20).forEach((s: any, index: number) => {
            const timeStr = s.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            const dateStr = s.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            keyboard.text(`${dateStr} ${timeStr}`, `book_slot_${s.id}`);
            if ((index + 1) % 2 === 0) keyboard.row();
        });

        await ctx.editMessageText("Добре, давай оберемо інший зручний час: 🗓️✨", { reply_markup: keyboard });

    } catch (e) {
        logger.error({ err: e, userId: ctx.from.id }, "Помилка при перенесенні співбесіди");
        await ctx.answerCallbackQuery("Сталася помилка.");
    }
});

// 5. Початок запису (вибір слоту)
bookingHandlers.callbackQuery("start_scheduling", async (ctx) => {
    await ctx.answerCallbackQuery();

    const slots = await interviewRepository.findActiveSlots();
    const telegramId = ctx.from.id;

    if (slots.length === 0) {
        logger.info({ userId: telegramId }, "⏳ [JOURNEY] Candidate start_scheduling: No slots available. Moving to WAITLIST.");

        // Auto-move to WAITLIST so HR can see them
        await candidateRepository.updateMany(
            { user: { telegramId: BigInt(telegramId) } },
            { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: FunnelStep.INTERVIEW }
        );

        const text = `Зараз графік співбесід оновлюється. ⏳\n\nЯ надішлю тобі сповіщення, як тільки з'являться нові вікна для запису. ✨`;
        const kb = new InlineKeyboard()
            .text("🔔 Повідомити мене", "no_slots_fit")
            .text("👩‍💼 Написати HR", "contact_hr");

        const msg = await ctx.reply(text, { reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // Notify HRs that someone is stuck
        const { HR_IDS } = await import("../config.js");
        if (HR_IDS && HR_IDS.length > 0) {
            const cand = await candidateRepository.findByTelegramId(telegramId);
            const name = cand?.fullName || ctx.from.first_name || "Candidate";
            const alertMsg = `📥 <b>INBOX: No interview slots available!</b>\n\n` +
                `👤 <b>${name}</b>\n\n` +
                `This candidate tried to book an interview but found NO SLOTS. She has been automatically moved to the WAITLIST. ⏳`;

            for (const hrId of HR_IDS) {
                try {
                    await ctx.api.sendMessage(hrId, alertMsg, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("👤 View Profile", `view_candidate_${cand?.id}`) });
                } catch (e) { }
            }
        }
        return;
    }

    const keyboard = new InlineKeyboard();

    // Групуємо слоти за датами
    const groupedSlots: Record<string, typeof slots> = {};
    slots.forEach(slot => {
        const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        if (!groupedSlots[dateStr]) groupedSlots[dateStr] = [];
        groupedSlots[dateStr].push(slot);
    });

    const dates = Object.keys(groupedSlots);
    for (const date of dates) {
        keyboard.text(`📅 --- ${date} ---`, `booking_date_header_${date.replace('.', '_')}`).row();
        const daySlots = groupedSlots[date]!;
        daySlots.forEach((slot, idx) => {
            const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            keyboard.text(timeStr, `book_slot_${slot.id}`);
            if ((idx + 1) % 4 === 0) keyboard.row();
        });
        keyboard.row();
    }

    keyboard.text("🙋‍♀️ Мені не підходить жодна дата", "no_slots_fit").row();

    await cleanupMessages(ctx);
    const msg = await ctx.reply("Обери зручний час для співбесіди: 🗓️✨", { reply_markup: keyboard });
    trackMessage(ctx, msg.message_id);
});

// 6. Немає вільних слотів / не підходять
bookingHandlers.callbackQuery("no_slots_fit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.info({ userId: telegramId }, `⏳ [JOURNEY] Candidate clicked 'No interview slots fit'`);

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: FunnelStep.INTERVIEW }
    );

    await ctx.editMessageText(`Домовились! Як тільки з'являться нові вікна — ти дізнаєшся про це першою. ✨`);

    const { HR_IDS } = await import("../config.js");
    if (HR_IDS && HR_IDS.length > 0) {
        const name = (await candidateRepository.findByTelegramId(telegramId))?.fullName || ctx.from.first_name || "Candidate";
        const alertMsg = `📥 <b>INBOX: Candidate cannot find interview slot!</b>\n\n` +
            `👤 <b>${name}</b>\n\n` +
            `This candidate clicked "No date fits". She is now in the WAITLIST. Please contact her! 💬`;

        for (const hrId of HR_IDS) {
            try {
                await ctx.api.sendMessage(hrId, alertMsg, { parse_mode: "HTML" });
            } catch (e) {
                logger.error({ err: e, hrId }, "Failed to send no_slots_fit alert to HR");
            }
        }
    }
});

// 6.5 Відмова кандидата від співбесіди (Не актуально)
bookingHandlers.callbackQuery("decline_invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.info({ userId: telegramId }, `⏳ [JOURNEY] Candidate declined the invite (no longer relevant)`);

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        {
            status: CandidateStatus.REJECTED,
            hrDecision: "REJECTED",
            candidateDecision: "Відмова кандидата (не актуально)",
            isWaitlisted: false,
            notificationSent: true
        }
    );

    const { STAFF_TEXTS } = await import("../constants/staff-texts.js");
    await ctx.editMessageText(STAFF_TEXTS["hr-info-invite-declined"] as string);
});

// 7. Початок запису НА НАВЧАННЯ / ЗНАЙОМСТВО
bookingHandlers.callbackQuery("start_training_scheduling", async (ctx) => {
    await ctx.answerCallbackQuery();

    const telegramId = ctx.from.id;
    const candidate = await candidateRepository.findByTelegramId(telegramId);
    const isDiscovery = candidate?.status === CandidateStatus.ACCEPTED || candidate?.status === CandidateStatus.DISCOVERY_SCHEDULED;

    const typeText = isDiscovery ? "коротку зустріч-знайомство" : "online-навчання";

    const slots = await trainingRepository.findActiveSlots();

    if (slots.length === 0) {
        logger.info({ userId: telegramId }, `⏳ [JOURNEY] Candidate start_training_scheduling: No ${isDiscovery ? 'discovery' : 'training'} slots available. Moving to WAITLIST.`);

        // Auto-move to WAITLIST so Mentor can see them
        await candidateRepository.updateMany(
            { user: { telegramId: BigInt(telegramId) } },
            { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: FunnelStep.TRAINING }
        );

        const text = `Зараз графік оновлюється. ⏳\n\nЯ надішлю тобі сповіщення, як тільки з'являться нові вікна для запису на ${typeText}. ✨`;
        const kb = new InlineKeyboard()
            .text("🔔 Повідомити мене", "training_no_slots_fit")
            .text("👩‍🏫 Написати наставниці", "contact_hr");
        const msg = await ctx.reply(text, { reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // Notify Mentors that someone is stuck
        const { MENTOR_IDS } = await import("../config.js");
        if (MENTOR_IDS && MENTOR_IDS.length > 0) {
            const cand = await candidateRepository.findByTelegramId(telegramId);
            const name = cand?.fullName || ctx.from.first_name || "Candidate";
            const alertMsg = `📥 <b>INBOX: No ${isDiscovery ? 'discovery' : 'training'} slots available!</b>\n\n` +
                `👤 <b>${name}</b>\n\n` +
                `This candidate tried to book ${typeText} but found NO SLOTS. She has been automatically moved to the WAITLIST. ⏳`;

            for (const mentorId of MENTOR_IDS) {
                try {
                    await ctx.api.sendMessage(mentorId, alertMsg, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("👤 View Profile", `view_candidate_${cand?.id}`) });
                } catch (e) { }
            }
        }
        return;
    }

    const keyboard = new InlineKeyboard();
    const groupedSlots: Record<string, typeof slots> = {};

    slots.forEach((slot: any) => {
        const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        if (!groupedSlots[dateStr]) groupedSlots[dateStr] = [];
        groupedSlots[dateStr].push(slot);
    });

    const dates = Object.keys(groupedSlots);
    for (const date of dates) {
        keyboard.text(`📅 --- ${date} ---`, `training_date_header_${date.replace('.', '_')}`).row();
        const daySlots = groupedSlots[date]!;
        daySlots.forEach((slot: any, idx: number) => {
            const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            keyboard.text(timeStr, `book_training_slot_${slot.id}`);
            if ((idx + 1) % 4 === 0) keyboard.row();
        });
        keyboard.row();
    }

    keyboard.text("🙋‍♀️ Мені не підходить жодна дата", "training_no_slots_fit").row();

    await cleanupMessages(ctx);
    const msg = await ctx.reply(`Обери зручний час для ${typeText}: 🗓️✨`, { reply_markup: keyboard });
    trackMessage(ctx, msg.message_id);
});

// In-memory lock to prevent double-click race conditions
const bookingLocks = new Set<number>();

// 8. Бронювання слоту НАВЧАННЯ / ЗНАЙОМСТВО
bookingHandlers.callbackQuery(/^book_training_slot_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1] as string;
    const telegramId = ctx.from.id;

    if (bookingLocks.has(telegramId)) {
        return await ctx.answerCallbackQuery("⏳ Зачекай, бронювання вже в процесі...");
    }

    // Idempotency: check if candidate already has a booked training/discovery
    const existingCand = await candidateRepository.findByTelegramId(telegramId);
    if (existingCand?.trainingSlotId || existingCand?.discoverySlotId) {
        return await ctx.answerCallbackQuery("✅ Ти вже маєш заброньований запис!");
    }

    bookingLocks.add(telegramId);

    try {
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

        const isDiscovery = candidate.status === CandidateStatus.ACCEPTED || candidate.status === CandidateStatus.DISCOVERY_SCHEDULED;
        const typeText = isDiscovery ? "знайомство" : "online-навчання";

        await ctx.answerCallbackQuery(`Бронюємо ${typeText}... ⏳`);
        logger.info({ userId: ctx.from.id, slotId, type: isDiscovery ? 'discovery' : 'training' }, `🎓 [JOURNEY] Booking training/discovery slot`);

        const result = isDiscovery
            ? await bookingService.bookDiscoverySlot(telegramId, slotId)
            : await bookingService.bookTrainingSlot(telegramId, slotId);

        const startTime = (result as any).startTime;
        const fullName = (result as any).candidate?.fullName || (result as any).candidateDiscovery?.fullName || ctx.from.first_name || "Кандидатко";
        const firstName = extractFirstName(fullName);

        const mentorDisplay = MENTOR_NAME.toLowerCase().includes("наставниц") ? MENTOR_NAME : `твоя наставниця ${MENTOR_NAME}`;

        let confirmationText = isDiscovery
            ? CANDIDATE_TEXTS["discovery-confirm"](MENTOR_NAME, startTime.toLocaleDateString('uk-UA'), startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }))
            : `✅ Вітаємо, <b>${firstName}</b>! Твій час для <b>online-навчання</b> заброньовано.\n\n` +
            `📅 Дата: <b>${startTime.toLocaleDateString('uk-UA')}</b>\n` +
            `⏰ Час: <b>${startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}</b>\n`;

        if ((result as any).googleMeetLink) {
            confirmationText += `\n📹 Google Meet: <a href="${(result as any).googleMeetLink}">Приєднатися до зустрічі</a>\n`;
        }

        if (!isDiscovery) {
            confirmationText += `\n${mentorDisplay.charAt(0).toUpperCase() + mentorDisplay.slice(1)} чекатиме на тебе в Google Meet! Готуйся! ✨`;
        }

        const kb = new InlineKeyboard()
            .text("🗓️ Перенести", `reschedule_training_${slotId}`).row()
            .text("❌ Скасувати запис", `cancel_training_${slotId}`).row()
            .text("👩‍🏫 Написати наставниці", "contact_hr");

        await cleanupMessages(ctx);
        const msg = await ctx.reply(confirmationText, { parse_mode: "HTML", reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // Notify Mentors
        const { MENTOR_IDS } = await import("../config.js");
        if (MENTOR_IDS.length > 0) {
            const mentorNotifyText = `🆕 <b>New ${isDiscovery ? 'discovery' : 'training'} appointment!</b>\n\n` +
                `👤 Candidate: <b>${fullName}</b>\n` +
                `📅 Time: <b>${startTime.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>\n\n` +
                `📍 Appointment added to Google Calendar.`;

            const mentorKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            await ctx.api.sendMessage(MENTOR_IDS[0]!, mentorNotifyText, { parse_mode: "HTML", reply_markup: mentorKb });
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, userId: telegramId }, "Помилка при бронюванні навчання або знайомства");
        if (e.message === "ALREADY_BOOKED") {
            await ctx.answerCallbackQuery("Цей час вже зайнятий, обери інший.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка. Спробуй ще раз. 😔");
        }
    } finally {
        bookingLocks.delete(telegramId);
    }
});

// 9. Training No Slots Fit
bookingHandlers.callbackQuery("training_no_slots_fit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.info({ userId: telegramId }, `⏳ [JOURNEY] Candidate clicked 'No training slots fit'`);

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        {
            status: CandidateStatus.WAITLIST,
            isWaitlisted: true,
            currentStep: FunnelStep.TRAINING // Explicitly set step for mentor waitlist
        }
    );

    await ctx.editMessageText(`Домовились! Як тільки з'являться нові вікна — ти дізнаєшся про це першою. ✨`);

    const { MENTOR_IDS } = await import("../config.js");
    if (MENTOR_IDS && MENTOR_IDS.length > 0) {
        const name = (await candidateRepository.findByTelegramId(telegramId))?.fullName || ctx.from.first_name || "Candidate";
        const alertMsg = `📥 <b>INBOX: Candidate cannot find training slot!</b>\n\n` +
            `👤 <b>${name}</b>\n\n` +
            `This candidate clicked "No date fits" for training. She is now in the WAITLIST. Please contact her! 💬`;

        for (const mentorId of MENTOR_IDS) {
            try {
                await ctx.api.sendMessage(mentorId, alertMsg, { parse_mode: "HTML" });
            } catch (e) {
                logger.error({ err: e, mentorId }, "Failed to send training_no_slots_fit alert to mentor");
            }
        }
    }
});

// 10. Скасування навчання
bookingHandlers.callbackQuery(/^cancel_training_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1] as string;

    try {
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        await bookingService.cancelTrainingSlot(slotId);
        // Reset status so candidate doesn't get stuck without a slot
        if (candidate && (candidate.status === CandidateStatus.TRAINING_SCHEDULED || candidate.status === CandidateStatus.DISCOVERY_SCHEDULED)) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.ACCEPTED,
                materialsSent: true
            });
        }
        await ctx.answerCallbackQuery("Запис на навчання скасовано.");
        await ctx.editMessageText("Твій запис на навчання скасовано. Якщо захочеш обрати інший час — тисни команду /start або кнопку нижче. 😊", {
            reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_training_scheduling")
        });

        // Notify Mentor about cancellation
        if (candidate) {
            const { MENTOR_IDS } = await import("../config.js");
            const isDiscovery = candidate.status === CandidateStatus.DISCOVERY_SCHEDULED;
            const typeText = isDiscovery ? "discovery" : "training";
            const name = candidate.fullName || "Candidate";
            const alertText = `❌ <b>${typeText.charAt(0).toUpperCase() + typeText.slice(1)} Cancelled</b>\n\n` +
                `👤 <b>${name}</b> cancelled her ${typeText} appointment.\n` +
                `She can rebook via the bot.`;
            const mentorKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const mentorId of MENTOR_IDS) {
                await ctx.api.sendMessage(mentorId, alertText, { parse_mode: "HTML", reply_markup: mentorKb }).catch(() => {});
            }
        }

    } catch (e) {
        logger.error({ err: e, slotId, userId: ctx.from.id }, "Помилка при скасуванні навчання");
        await ctx.answerCallbackQuery("Сталася помилка.");
    }
});

// 11. Перенесення навчання
bookingHandlers.callbackQuery(/^reschedule_training_(.+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery("Обирай новий час!");

        // Notify Mentor about reschedule
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        if (candidate) {
            const { MENTOR_IDS } = await import("../config.js");
            const isDiscovery = candidate.status === CandidateStatus.DISCOVERY_SCHEDULED;
            const typeText = isDiscovery ? "discovery" : "training";
            const name = candidate.fullName || "Candidate";
            const alertText = `🗓 <b>${typeText.charAt(0).toUpperCase() + typeText.slice(1)} Rescheduled</b>\n\n` +
                `👤 <b>${name}</b> is rescheduling her ${typeText} appointment.\n` +
                `She is choosing a new time now.`;
            const mentorKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const mentorId of MENTOR_IDS) {
                await ctx.api.sendMessage(mentorId, alertText, { parse_mode: "HTML", reply_markup: mentorKb }).catch(() => {});
            }
        }

        const slots = await trainingRepository.findActiveSlots();

        if (slots.length === 0) {
            return ctx.editMessageText("Зараз вільних слотів для навчання немає. HR зв'яжеться з тобою! ✨", {
                reply_markup: new InlineKeyboard().text("👩‍💼 Написати HR", "contact_hr")
            });
        }

        const keyboard = new InlineKeyboard();
        slots.slice(0, 20).forEach((s: any, index: number) => {
            const timeStr = s.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            const dateStr = s.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            keyboard.text(`${dateStr} ${timeStr}`, `book_training_slot_${s.id}`);
            if ((index + 1) % 2 === 0) keyboard.row();
        });

        await ctx.editMessageText("Добре, давай оберемо інший зручний час для навчання: 🗓️✨", { reply_markup: keyboard });

    } catch (e) {
        logger.error({ err: e, userId: ctx.from.id }, "Помилка при перенесенні навчання");
        await ctx.answerCallbackQuery("Сталася помилка.");
    }
});
