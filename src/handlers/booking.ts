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
import { buildSignedCallback, readCallbackPayload } from "../utils/signed-callback.js";
import { ActionDedupeWindow } from "../utils/action-dedupe.js";
import { getBirthDateRejection } from "../utils/candidate-age.js";

export const bookingHandlers = new Composer<MyContext>();

const INTERVIEW_WAITLIST_REASON_NO_SLOTS = "NO_SLOTS_AVAILABLE";
const INTERVIEW_WAITLIST_REASON_NO_DATE_FITS = "NO_DATE_FITS";
const BOOKING_ACTION_DEBOUNCE_MS = 15_000;
const bookingActionDedupe = new ActionDedupeWindow(BOOKING_ACTION_DEBOUNCE_MS);

export function buildMentorReschedulePatch(status: CandidateStatus) {
    const isDiscovery = status === CandidateStatus.DISCOVERY_SCHEDULED;

    return {
        status: isDiscovery ? CandidateStatus.ACCEPTED : CandidateStatus.WAITLIST_MENTOR,
        candidateDecision: null,
        notificationSent: false,
        currentStep: FunnelStep.TRAINING,
        isWaitlisted: isDiscovery ? false : true,
        trainingMeetLink: null
    };
}

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
        const ageRejection = getBirthDateRejection(candidate.birthDate);
        if (ageRejection) {
            if (candidate.status !== CandidateStatus.REJECTED ||
                (ageRejection === "AGE_LIMIT" && candidate.hrDecision !== "AGE_LIMIT") ||
                (ageRejection === "UNDERAGE" && candidate.hrDecision !== "REJECTED_SYSTEM_UNDERAGE")) {
                await candidateRepository.update(candidate.id, {
                    status: CandidateStatus.REJECTED,
                    hrDecision: ageRejection === "AGE_LIMIT" ? "AGE_LIMIT" : "REJECTED_SYSTEM_UNDERAGE",
                    isWaitlisted: false,
                    notificationSent: false,
                    interviewWaitlistReason: null,
                    hasUnreadMessage: false,
                });
            }

            await ctx.answerCallbackQuery("Зараз запис для цієї анкети недоступний.");
            await ScreenManager.renderScreen(
                ctx,
                ageRejection === "AGE_LIMIT"
                    ? CANDIDATE_TEXTS["candidate-reject-age-limit"]
                    : CANDIDATE_TEXTS["candidate-reject-underage"]
            );
            return;
        }

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
            CandidateStatus.READY_FOR_HIRE,
            CandidateStatus.SCREENING,
            CandidateStatus.REJECTED
        ];
        if (forbiddenStatuses.includes(candidate.status)) {
            await ctx.answerCallbackQuery("⚠️ Твоє навчання вже завершене! Оновлюю меню... ✨");
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        }
        // Block HR-waitlist candidates (no HR approval yet)
        if (candidate.status === CandidateStatus.WAITLIST_HR ||
            (candidate.status === CandidateStatus.WAITLIST && candidate.currentStep !== FunnelStep.TRAINING)) {
            await ctx.answerCallbackQuery("⏳ Твоя заявка ще на розгляді у HR.");
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

function isDuplicateBookingAction(actionKey: string) {
    return !bookingActionDedupe.tryAcquire(actionKey);
}

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
        logger.debug({ telegramId, slotId }, "Interview booking started");
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
            .text("🗓️ Змінити час", buildSignedCallback("rb", result.slot.id)).row()
            .text("❌ Скасувати запис", buildSignedCallback("cb", result.slot.id)).row()
            .text("🚫 Відмовитись від вакансії", buildSignedCallback("wi", result.slot.id));
        if ((result as any).candidate?.gender !== "male") {
            kb.row().text("👩‍💼 Написати HR", "contact_hr");
        }

        await cleanupMessages(ctx);
        const confirmationMsg = await ctx.reply(confirmationText, { parse_mode: "HTML", reply_markup: kb });
        trackMessage(ctx, confirmationMsg.message_id);

        // --- TIMELINE TRACKING ---
        import("../services/timeline-service.js").then(({ timelineService }) => {
            const trackedUserId = existingCand?.userId || result.slot.candidate?.userId;
            if (trackedUserId) {
                timelineService.trackEvent(
                    trackedUserId,
                    `Забронювала співбесіду: ${startTime.toLocaleString('uk-UA')}`,
                    { slotId, startTime, event: "candidate.interview.booked" }
                ).catch(() => {});
            }
        }).catch(() => {});

        const { HR_IDS } = await import("../config.js");
        if (HR_IDS.length > 0) {
            const hrNotifyText = `🆕 <b>New interview appointment!</b>\n\n` +
                `👤 Candidate: <b>${fullName}</b>\n` +
                `📅 Time: <b>${startTime.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}</b>\n\n` +
                `📍 Appointment added to Google Calendar.`;

            const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${(result as any).candidate?.id}`);
            await ctx.api.sendMessage(HR_IDS[0]!, hrNotifyText, { parse_mode: "HTML", reply_markup: hrKb });
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, telegramId }, "Interview booking failed");
        if (e.message === "ALREADY_BOOKED") {
            await ctx.answerCallbackQuery("Вибач, цей слот вже зайнятий. 😔");
        } else if (e.message === "UNDERAGE_CANDIDATE") {
            await ctx.answerCallbackQuery("Цей етап доступний лише після 17 років.");
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-underage"]);
        } else if (e.message === "AGE_LIMIT_CANDIDATE") {
            await ctx.answerCallbackQuery("Зараз запис для цієї анкети недоступний.");
            await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["candidate-reject-age-limit"]);
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    } finally {
        bookingLocks.delete(telegramId);
    }
});

// 2. Скасування запису — крок 1: підтвердження
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "cb" });
    if (!slotId) return next();
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
        .text("✅ Так, скасувати запис", buildSignedCallback("ccb", slotId)).row()
        .text("⬅️ Ні, повернутись", "cancel_dismiss");

    await ctx.editMessageText(
        `⚠️ <b>Ти впевнена, що хочеш скасувати запис?</b>\n\n` +
        `Ми звільнимо цей час, а ти зможеш обрати інший слот для співбесіди, коли буде зручно. 🌸`,
        { parse_mode: "HTML", reply_markup: kb }
    );
    return;
});

// 2.1. Скасування запису — крок 2: підтверджено → back to interview slot selection
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "ccb" });
    if (!slotId) return next();
    if (isDuplicateBookingAction(`cancel-interview:${ctx.from.id}:${slotId}`)) {
        await ctx.answerCallbackQuery("✅ Скасування вже обробляється.");
        return;
    }

    try {
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        await bookingService.cancelInterviewSlot(slotId, ctx.from.id);

        if (candidate) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.WAITLIST_HR,
                currentStep: FunnelStep.INTERVIEW,
                isWaitlisted: true,
                candidateDecision: null,
                notificationSent: false,
                interviewWaitlistReason: null,
                interviewSlot: { disconnect: true },
                googleMeetLink: null
            });
        }

        await ctx.answerCallbackQuery("Запис скасовано.");
        await ctx.editMessageText(
            "Готово, цей запис скасовано. 🌸\n\n" +
            "Коли будеш готова, обери інший зручний час для співбесіди.",
            { reply_markup: new InlineKeyboard().text("🗓️ Обрати інший час", "start_scheduling") }
        );

        // Notify HR
        if (candidate) {
            const { HR_IDS } = await import("../config.js");
            const name = candidate.fullName || "Candidate";
            const alertText = `🗓 <b>Interview Booking Cancelled</b>\n\n` +
                `👤 <b>${name}</b> cancelled her interview slot and can choose another time.`;
            const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const hrId of HR_IDS) {
                await ctx.api.sendMessage(hrId, alertText, { parse_mode: "HTML", reply_markup: hrKb }).catch(() => {});
            }
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, telegramId: ctx.from.id }, "Interview cancellation failed");
        if (e.message === "FORBIDDEN_SLOT_ACCESS") {
            await ctx.answerCallbackQuery("Ця дія недоступна для цього запису.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    }
});

// 3. Повна відмова від вакансії — крок 1: явне підтвердження
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "wi" });
    if (!slotId) return next();
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
        .text("🚫 Так, відмовитись", buildSignedCallback("cwi", slotId)).row()
        .text("⬅️ Ні, повернутись", "cancel_dismiss");

    await ctx.editMessageText(
        `⚠️ <b>Ти впевнена, що хочеш відмовитись від вакансії?</b>\n\n` +
        `Ми закриємо твою заявку та скасуємо запис на співбесіду. Якщо просто не підходить час — повернись і обери «Скасувати запис» або «Змінити час».`,
        { parse_mode: "HTML", reply_markup: kb }
    );
});

// 3.1. Повна відмова від вакансії — крок 2: підтверджено → REJECTED
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "cwi" });
    if (!slotId) return next();
    if (isDuplicateBookingAction(`withdraw-interview:${ctx.from.id}:${slotId}`)) {
        await ctx.answerCallbackQuery("✅ Відмову вже зафіксовано.");
        return;
    }

    try {
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        if (slotId !== "none") {
            await bookingService.cancelInterviewSlot(slotId, ctx.from.id);
        }

        if (candidate) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.REJECTED,
                candidateDecision: "Кандидатка відмовилась від вакансії",
                notificationSent: true,
                interviewWaitlistReason: null,
                interviewSlot: { disconnect: true },
                googleMeetLink: null
            });
        }

        await ctx.answerCallbackQuery("Відмову зафіксовано.");
        await ctx.editMessageText(
            "Дякуємо, що повідомила. 🌸\n\n" +
            "Ми закрили твою заявку. Бажаємо успіхів, і якщо в майбутньому захочеш повернутися — будемо раді бачити тебе знову. ✨"
        );

        if (candidate) {
            const { HR_IDS } = await import("../config.js");
            const name = candidate.fullName || "Candidate";
            const alertText = `🚫 <b>Candidate Withdrew</b>\n\n` +
                `👤 <b>${name}</b> declined the vacancy after booking an interview.`;
            const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const hrId of HR_IDS) {
                await ctx.api.sendMessage(hrId, alertText, { parse_mode: "HTML", reply_markup: hrKb }).catch(() => {});
            }
        }
    } catch (e: any) {
        logger.error({ err: e, slotId, telegramId: ctx.from.id }, "Interview vacancy withdrawal failed");
        if (e.message === "FORBIDDEN_SLOT_ACCESS") {
            await ctx.answerCallbackQuery("Ця дія недоступна для цього запису.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    }
});

// 4. Зміна часу співбесіди — одразу звільняє поточний слот і показує нові
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "rb" });
    if (!slotId) return next();
    try {
        await ctx.answerCallbackQuery("Обирай новий час!");

        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);

        // Release current slot first so it appears in the new list
        await bookingService.cancelInterviewSlot(slotId, ctx.from.id);
        if (candidate) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.WAITLIST_HR,
                isWaitlisted: true,
                currentStep: FunnelStep.INTERVIEW,
                candidateDecision: null,
                notificationSent: false,
                interviewSlot: { disconnect: true },
                googleMeetLink: null
            });
        }

        // Notify HR
        if (candidate) {
            const { HR_IDS } = await import("../config.js");
            const name = candidate.fullName || "Candidate";
            const alertText = `🗓 <b>Interview Rescheduled</b>\n\n` +
                `👤 <b>${name}</b> is choosing a new interview time.`;
            const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const hrId of HR_IDS) {
                await ctx.api.sendMessage(hrId, alertText, { parse_mode: "HTML", reply_markup: hrKb }).catch(() => {});
            }
        }

        const slots = await interviewRepository.findActiveSlots();

        if (slots.length === 0) {
            if (candidate) {
                await candidateRepository.update(candidate.id, {
                    interviewWaitlistReason: INTERVIEW_WAITLIST_REASON_NO_SLOTS
                });
            }
            await ctx.editMessageText(`Зараз графік співбесід оновлюється. ⏳\n\nЯ надішлю тобі сповіщення, як тільки з'являться нові вікна для запису. ✨`);
            return;
        }

        const keyboard = new InlineKeyboard();
        slots.slice(0, 20).forEach((s: any, index: number) => {
            const timeStr = s.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            const dateStr = s.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
            keyboard.text(`${dateStr} ${timeStr}`, `book_slot_${s.id}`);
            if ((index + 1) % 2 === 0) keyboard.row();
        });
        keyboard.row().text("🙋‍♀️ Мені не підходить жодна дата", "no_slots_fit").row();

        await ctx.editMessageText("Добре, давай оберемо інший зручний час: 🗓️✨", { reply_markup: keyboard });

    } catch (e: any) {
        logger.error({ err: e, telegramId: ctx.from.id }, "Interview reschedule failed");
        if (e.message === "FORBIDDEN_SLOT_ACCESS") {
            await ctx.answerCallbackQuery("Ця дія недоступна для цього запису.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    }
});

// 5. Початок запису (вибір слоту)
bookingHandlers.callbackQuery("start_scheduling", async (ctx) => {
    await ctx.answerCallbackQuery();

    const slots = await interviewRepository.findActiveSlots();
    const telegramId = ctx.from.id;

    if (slots.length === 0) {
        logger.debug({ telegramId }, "Interview scheduling waitlist fallback activated");

        // Auto-move to WAITLIST_HR so HR can see them
        await candidateRepository.updateMany(
            { user: { telegramId: BigInt(telegramId) } },
            {
                status: CandidateStatus.WAITLIST_HR,
                isWaitlisted: true,
                currentStep: FunnelStep.INTERVIEW,
                interviewWaitlistReason: INTERVIEW_WAITLIST_REASON_NO_SLOTS
            }
        );

        const text = `Зараз графік співбесід оновлюється. ⏳\n\nЯ надішлю тобі сповіщення, як тільки з'являться нові вікна для запису. ✨`;
        const kb = new InlineKeyboard().text("🔔 Повідомити мене", "no_slots_available_ack");
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (candidate?.gender !== "male") {
            kb.text("👩‍💼 Написати HR", "contact_hr");
        }

        const msg = await ctx.reply(text, { reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // Notify HRs that someone is stuck
        const { HR_IDS } = await import("../config.js");
        if (HR_IDS && HR_IDS.length > 0) {
            const cand = candidate || await candidateRepository.findByTelegramId(telegramId);
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
        const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
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

bookingHandlers.callbackQuery("no_slots_available_ack", async (ctx) => {
    await ctx.answerCallbackQuery("Домовились, повідомимо, щойно з'являться нові вікна ✨");
});

// 6. Немає вільних слотів / не підходять
bookingHandlers.callbackQuery("no_slots_fit", async (ctx) => {
    if (isDuplicateBookingAction(`no-slots-fit:${ctx.from.id}`)) {
        await ctx.answerCallbackQuery("✅ Я вже зафіксувала, що жодна дата не підходить.");
        return;
    }
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.debug({ telegramId }, "Interview scheduling no-slots-fit selected");

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        {
            status: CandidateStatus.WAITLIST_HR,
            isWaitlisted: true,
            currentStep: FunnelStep.INTERVIEW,
            interviewWaitlistReason: INTERVIEW_WAITLIST_REASON_NO_DATE_FITS
        }
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

// 6.5 Відмова кандидата від співбесіди
bookingHandlers.callbackQuery("decline_invite", async (ctx) => {
    if (isDuplicateBookingAction(`decline-invite:${ctx.from.id}`)) {
        await ctx.answerCallbackQuery("✅ Відмову вже зафіксовано.");
        return;
    }
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.debug({ telegramId }, "Interview invite declined by candidate");

    const candidate = await candidateRepository.findByTelegramId(telegramId);
    if (candidate?.interviewSlotId) {
        await bookingService.cancelInterviewSlot(candidate.interviewSlotId, telegramId).catch((err) => {
            logger.warn({ err, candidateId: candidate.id, slotId: candidate.interviewSlotId }, "Interview decline cleanup failed");
        });
    }

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        {
            status: CandidateStatus.REJECTED,
            hrDecision: "REJECTED",
            candidateDecision: "Відмова кандидата (не актуально)",
            isWaitlisted: false,
            notificationSent: true,
            googleMeetLink: null
        }
    );

    const { STAFF_TEXTS } = await import("../constants/staff-texts.js");
    await ctx.editMessageText(STAFF_TEXTS["hr-info-invite-declined"] as string);

    // Notify HR
    if (candidate) {
        const { HR_IDS } = await import("../config.js");
        const name = candidate.fullName || "Candidate";
        const alertText = `🚫 <b>Candidate Withdrew</b>\n\n` +
            `👤 <b>${name}</b> declined the interview invite.\n` +
            `Reason: no longer relevant for her.`;
        const hrKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
        for (const hrId of HR_IDS) {
            await ctx.api.sendMessage(hrId, alertText, { parse_mode: "HTML", reply_markup: hrKb }).catch(() => {});
        }
    }
});

// 7. Початок запису НА НАВЧАННЯ / ЗНАЙОМСТВО
bookingHandlers.callbackQuery("start_training_scheduling", async (ctx) => {
    await ctx.answerCallbackQuery();

    const telegramId = ctx.from.id;

    // Validate candidate is eligible for training scheduling
    const candidate = await candidateRepository.findByTelegramId(telegramId);
    if (!candidate) return;

    const allowedStatuses: CandidateStatus[] = [
        CandidateStatus.ACCEPTED,
        CandidateStatus.DISCOVERY_COMPLETED,
        CandidateStatus.TRAINING_SCHEDULED
    ];
    const isWaitlistMentor = candidate.status === CandidateStatus.WAITLIST_MENTOR ||
        (candidate.status === CandidateStatus.WAITLIST && candidate.currentStep === FunnelStep.TRAINING);

    if (!allowedStatuses.includes(candidate.status) && !isWaitlistMentor) {
        logger.warn({ userId: telegramId, status: candidate.status, currentStep: candidate.currentStep },
            "Training scheduling blocked because candidate status is invalid");
        const { showCandidateStatus } = await import("../utils/candidate-ui.js");
        await showCandidateStatus(ctx, candidate);
        return;
    }

    const slots = await trainingRepository.findActiveSlots();

    if (slots.length === 0) {
        logger.debug({ telegramId }, "Training scheduling waitlist fallback activated");

        // Auto-move to WAITLIST so Mentor can see them
        await candidateRepository.updateMany(
            { user: { telegramId: BigInt(telegramId) } },
            { status: CandidateStatus.WAITLIST_MENTOR, isWaitlisted: true, currentStep: FunnelStep.TRAINING }
        );

        const text = `Зараз графік оновлюється. ⏳\n\nЯ надішлю тобі сповіщення, як тільки з'являться нові вікна для запису на коротку зустріч-знайомство. ✨`;
        const kb = new InlineKeyboard()
            .text("🔔 Повідомити мене", "training_no_slots_fit")
            .text("👩‍🏫 Написати наставниці", "contact_mentor");
        const msg = await ctx.reply(text, { reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // Notify Mentors that someone is stuck
        const { MENTOR_IDS } = await import("../config.js");
        if (MENTOR_IDS && MENTOR_IDS.length > 0) {
            const cand = await candidateRepository.findByTelegramId(telegramId);
            const name = cand?.fullName || ctx.from.first_name || "Candidate";
            const alertMsg = `📥 <b>INBOX: No discovery slots available!</b>\n\n` +
                `👤 <b>${name}</b>\n\n` +
                `This candidate tried to book a discovery but found NO SLOTS. She has been automatically moved to the WAITLIST. ⏳`;

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
        const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
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
    const msg = await ctx.reply(`Обери зручний час для зустрічі-знайомства: 🗓️✨`, { reply_markup: keyboard });
    trackMessage(ctx, msg.message_id);
});

// In-memory lock to prevent double-click race conditions
const bookingLocks = new Set<number>();

// 8. Бронювання слоту ЗНАЙОМСТВО або НАВЧАННЯ (кандидатка обирає час сама)
bookingHandlers.callbackQuery(/^book_training_slot_(.+)$/, async (ctx) => {
    const slotId = ctx.match[1] as string;
    const telegramId = ctx.from.id;

    if (bookingLocks.has(telegramId)) {
        return await ctx.answerCallbackQuery("⏳ Зачекай, бронювання вже в процесі...");
    }

    const existingCand = await candidateRepository.findByTelegramId(telegramId);
    if (!existingCand) {
        return await ctx.answerCallbackQuery("Кандидата не знайдено!");
    }

    const isTrainingPhase = existingCand.status === CandidateStatus.DISCOVERY_COMPLETED || 
                            existingCand.status === CandidateStatus.TRAINING_SCHEDULED;

    // Idempotency check appropriate for phase
    if (isTrainingPhase) {
        if (existingCand.trainingSlotId) {
            return await ctx.answerCallbackQuery("✅ Ти вже маєш заброньований запис на навчання!");
        }
    } else {
        if (existingCand.discoverySlotId) {
            return await ctx.answerCallbackQuery("✅ Ти вже маєш заброньований запис на знайомство!");
        }
    }

    bookingLocks.add(telegramId);

    try {
        await ctx.answerCallbackQuery(isTrainingPhase ? "Бронюємо навчання... ⏳" : "Бронюємо знайомство... ⏳");
        logger.debug({ telegramId, slotId, phase: isTrainingPhase ? "training" : "discovery" }, "Training or discovery booking started");

        const result = isTrainingPhase 
            ? await bookingService.bookTrainingSlot(telegramId, slotId)
            : await bookingService.bookDiscoverySlot(telegramId, slotId);

        const startTime = (result as any).startTime;
        const candData = isTrainingPhase ? (result as any).candidate : (result as any).candidateDiscovery;
        const fullName = candData?.fullName || ctx.from.first_name || "Кандидатко";

        let confirmationText = "";
        if (isTrainingPhase) {
            confirmationText = CANDIDATE_TEXTS["candidate-training-scheduled"](
                "навчання",
                startTime.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }),
                startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }),
                result.googleMeetLink
            );
        } else {
            confirmationText = CANDIDATE_TEXTS["discovery-confirm"](
                MENTOR_NAME,
                startTime.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }),
                startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })
            );
        }

        const kb = new InlineKeyboard()
            .text("🗓️ Змінити час", buildSignedCallback("rt", slotId)).row()
            .text("❌ Скасувати участь", buildSignedCallback("ct", slotId)).row()
            .text("👩‍🏫 Написати наставниці", "contact_mentor");

        await cleanupMessages(ctx);
        const msg = await ctx.reply(confirmationText, { parse_mode: "HTML", reply_markup: kb });
        trackMessage(ctx, msg.message_id);

        // --- TIMELINE TRACKING ---
        const typeText = isTrainingPhase ? "навчання" : "знайомство";
        import("../services/timeline-service.js").then(({ timelineService }) => {
            timelineService.trackEvent(existingCand.userId, `Забронювала ${typeText}: ${startTime.toLocaleString('uk-UA')}`, { slotId, type: typeText, startTime }).catch(() => {});
        }).catch(() => {});

        // Notify Mentors
        const { MENTOR_IDS } = await import("../config.js");
        if (MENTOR_IDS.length > 0) {
            const typeText = isTrainingPhase ? "training" : "discovery";
            const mentorNotifyText = `🆕 <b>New ${typeText} appointment!</b>\n\n` +
                `👤 Candidate: <b>${fullName}</b>\n` +
                `📅 Time: <b>${startTime.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' })}</b>\n\n` +
                `📍 Appointment added to Google Calendar.`;

            const mentorKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${existingCand.id}`);
            await ctx.api.sendMessage(MENTOR_IDS[0]!, mentorNotifyText, { parse_mode: "HTML", reply_markup: mentorKb });
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, telegramId }, "Training or discovery booking failed");
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
    if (isDuplicateBookingAction(`training-no-slots-fit:${ctx.from.id}`)) {
        await ctx.answerCallbackQuery("✅ Я вже зафіксувала, що жодна дата не підходить.");
        return;
    }
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from.id;
    logger.debug({ telegramId }, "Training scheduling no-slots-fit selected");

    await candidateRepository.updateMany(
        { user: { telegramId: BigInt(telegramId) } },
        {
            status: CandidateStatus.WAITLIST_MENTOR,
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

// 10. Скасування навчання — крок 1: підтвердження
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "ct" });
    if (!slotId) return next();
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard()
        .text("🚫 Так, відмовляюсь", buildSignedCallback("cct", slotId)).row()
        .text("⬅️ Ні, повернутись", "cancel_dismiss");

    await ctx.editMessageText(
        `⚠️ <b>Ти впевнена, що хочеш скасувати?</b>\n\n` +
        `Твою заявку буде закрито, а анкету видалено з нашої системи. Якщо в майбутньому захочеш повернутися — потрібно буде подати заявку заново.\n\n` +
        `Якщо просто хочеш змінити час — поверніться і натисни «Змінити час». 🌸`,
        { parse_mode: "HTML", reply_markup: kb }
    );
    return;
});

// 10.1. Скасування навчання — крок 2: підтверджено
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "cct" });
    if (!slotId) return next();
    if (isDuplicateBookingAction(`cancel-training:${ctx.from.id}:${slotId}`)) {
        await ctx.answerCallbackQuery("✅ Скасування вже обробляється.");
        return;
    }

    try {
        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
        // Save original status BEFORE update for correct notification
        const wasDiscovery = candidate?.status === CandidateStatus.DISCOVERY_SCHEDULED;

        await bookingService.cancelTrainingSlot(slotId, ctx.from.id);

        if (candidate) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.REJECTED,
                candidateDecision: "Кандидатка скасувала заявку самостійно",
                notificationSent: true,
                discoverySlot: { disconnect: true },
                trainingSlot: { disconnect: true },
                trainingMeetLink: null
            });
        }

        await ctx.answerCallbackQuery("Заявку скасовано.");
        await ctx.editMessageText(
            "Зрозуміли, дякуємо, що попередила! 🌸\n\n" +
            "Бажаємо тобі успіхів у пошуках і всього найкращого! Якщо в майбутньому захочеш повернутися — ми будемо раді бачити тебе. ✨"
        );

        // Notify Mentor
        if (candidate) {
            const { MENTOR_IDS } = await import("../config.js");
            const typeText = wasDiscovery ? "discovery" : "training";
            const name = candidate.fullName || "Candidate";
            const alertText = `🚫 <b>Candidate Withdrew</b>\n\n` +
                `👤 <b>${name}</b> cancelled her ${typeText} and left the pipeline.\n` +
                `Reason: candidate decided not to continue.`;
            const mentorKb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
            for (const mentorId of MENTOR_IDS) {
                await ctx.api.sendMessage(mentorId, alertText, { parse_mode: "HTML", reply_markup: mentorKb }).catch(() => {});
            }
        }

    } catch (e: any) {
        logger.error({ err: e, slotId, telegramId: ctx.from.id }, "Training cancellation failed");
        if (e.message === "FORBIDDEN_SLOT_ACCESS") {
            await ctx.answerCallbackQuery("Ця дія недоступна для цього запису.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    }
});

// 10.2. Скасування — повернутись (dismiss)
bookingHandlers.callbackQuery("cancel_dismiss", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { showCandidateStatus } = await import("../utils/candidate-ui.js");
    const candidate = await candidateRepository.findByTelegramId(ctx.from.id);
    if (candidate) {
        await showCandidateStatus(ctx, candidate);
    }
});

// 11. Зміна часу навчання — одразу звільняє поточний слот і показує нові
bookingHandlers.on("callback_query:data", async (ctx, next) => {
    const slotId = readCallbackPayload(ctx.callbackQuery.data, { code: "rt" });
    if (!slotId) return next();
    try {
        await ctx.answerCallbackQuery("Обирай новий час!");

        const candidate = await candidateRepository.findByTelegramId(ctx.from.id);

        // Release the booked slot before updating candidate state.
        // Disconnecting the relation first can leave a slot stuck with isBooked=true
        // but no linked candidate, which makes it disappear from the schedule.
        await bookingService.cancelTrainingSlot(slotId, ctx.from.id);

        if (candidate) {
            await candidateRepository.update(candidate.id, buildMentorReschedulePatch(candidate.status));
        }

        // Notify Mentor about reschedule
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
            // Notify Mentor
            if (candidate) {
                const { MENTOR_IDS: mentorIds } = await import("../config.js");
                const name = candidate.fullName || "Candidate";
                const alertText = `⚠️ <b>No Slots Available</b>\n\n` +
                    `👤 <b>${name}</b> tried to reschedule but found no available slots.\n` +
                    `She is back in Inbox — please assign a time manually.`;
                const kb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
                for (const mentorId of mentorIds) {
                    await ctx.api.sendMessage(mentorId, alertText, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
                }
            }

            return ctx.editMessageText("Зараз вільних слотів немає. Наставниця скоро запропонує тобі зручний час! 🌸✨", {
                reply_markup: new InlineKeyboard().text("👩‍🏫 Написати наставниці", "contact_mentor")
            });
        }

        const keyboard = new InlineKeyboard();
        slots.slice(0, 20).forEach((s: any, index: number) => {
            const timeStr = s.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            const dateStr = s.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
            keyboard.text(`${dateStr} ${timeStr}`, `book_training_slot_${s.id}`);
            if ((index + 1) % 2 === 0) keyboard.row();
        });

        await ctx.editMessageText("Добре, давай оберемо інший зручний час для навчання: 🗓️✨", { reply_markup: keyboard });

    } catch (e: any) {
        logger.error({ err: e, telegramId: ctx.from.id }, "Training reschedule failed");
        if (e.message === "FORBIDDEN_SLOT_ACCESS") {
            await ctx.answerCallbackQuery("Ця дія недоступна для цього запису.");
        } else {
            await ctx.answerCallbackQuery("Сталася помилка.");
        }
    }
});
