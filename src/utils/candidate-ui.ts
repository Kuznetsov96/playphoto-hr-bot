import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { CandidateStatus } from "@prisma/client";
import { ScreenManager } from "./screen-manager.js";
import { HR_NAME } from "../config.js";
import { buildJobDetailsText, type JobDetailsLocation } from "./job-details.js";
import logger from "../core/logger.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { cleanupMessages, trackMessage } from "./cleanup.js";
import { formatLocation } from "./location-label.js";
import { canScheduleInterview, hasInterviewStarted, isQuestionnaireOpen } from "./screening-state.js";
import { buildBookedInterviewKeyboard } from "./interview-booking-keyboard.js";

function getCandidateAge(birthDate?: Date | string | null): number | null {
    if (!birthDate) return null;

    const parsedBirthDate = birthDate instanceof Date ? birthDate : new Date(birthDate);
    if (Number.isNaN(parsedBirthDate.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - parsedBirthDate.getFullYear();
    const monthDelta = today.getMonth() - parsedBirthDate.getMonth();

    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < parsedBirthDate.getDate())) {
        age -= 1;
    }

    return age;
}

function hasBlockedDeliveryReason(candidate: any): boolean {
    return candidate.status === CandidateStatus.BLOCKER || candidate.candidateDecision?.includes("Бот заблоковано") === true;
}

function isRecoveryEligibleCandidate(candidate: any): boolean {
    const age = getCandidateAge(candidate.birthDate);
    return candidate.gender === "female" && age !== null && age >= 17 && age <= 26 && hasBlockedDeliveryReason(candidate);
}

/**
 * Текст екрана /start після відмови — за причиною (аудит 01.10.2026, тексти
 * погоджено власником). Раніше всім ішло «ми не зможемо запропонувати вам
 * місце», і та, що сама закрила заявку, читала це як нашу відмову.
 *
 * - сама закрила заявку: candidateDecision пишуть лише її власні дії
 *   (booking.ts decline_invite / cwi / відмова на етапі навчання,
 *   hr-service відмова від стажування). Виняток — «Бот заблоковано»
 *   (utils/bot-blocked.ts): це доставка, а не її рішення;
 * - замолода (REJECTED_SYSTEM_UNDERAGE): той самий текст, що прийшов при
 *   відмові, — хлопцю відмова хлопцю, бо обіцянка «бот нагадає» йому не діє;
 * - решта (HR, неявка, вік понад межу) — загальна відмова.
 */
export function selectRejectedStatusText(candidate: any): string {
    if (candidate.candidateDecision && !hasBlockedDeliveryReason(candidate)) {
        return CANDIDATE_TEXTS["candidate-withdrawn"];
    }
    if (candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE") {
        return candidate.gender === "male"
            ? CANDIDATE_TEXTS["candidate-reject-male-location"]
            : CANDIDATE_TEXTS["candidate-reject-underage"];
    }
    return CANDIDATE_TEXTS["candidate-rejected"];
}

/**
 * Блок «Твоя робота»: дані точки зі знімка вебаппа (рішення власника
 * 01.10.2026). Кандидатку вантажать різні місця, і години роботи (окрема
 * таблиця) приходять не завжди — дочитуємо локацію разом із ними. Збій
 * читання не ламає екран статусу: блок тоді будується з того, що є.
 */
async function getJobDetailsText(candidate: any): Promise<string | null> {
    let location: JobDetailsLocation | null = candidate.location ?? null;
    const locationId: string | undefined = candidate.location?.id ?? candidate.locationId ?? undefined;
    if (locationId && !Array.isArray(candidate.location?.openingHours)) {
        try {
            const { default: prisma } = await import("../db/core.js");
            location = await prisma.location.findUnique({
                where: { id: locationId },
                include: { openingHours: { orderBy: { dayOfWeek: "asc" } } },
            }) ?? location;
        } catch (error) {
            logger.warn({ err: error, locationId }, "Job details: could not load location opening hours");
        }
    }
    return buildJobDetailsText(location);
}

export async function showCandidateStatus(ctx: MyContext, candidate: any) {
    const status = candidate.status;
    let text = "";
    let kb = new InlineKeyboard();
    const canContactStaff = candidate.gender !== "male";
    const canUseRecovery = isRecoveryEligibleCandidate(candidate);

    // Dashboard logic: Show info for Accepted and beyond
    const isAcceptedOrBeyond = [
        CandidateStatus.INTERVIEW_COMPLETED, CandidateStatus.DECISION_PENDING,
        CandidateStatus.ACCEPTED, CandidateStatus.MENTOR_MANUAL, CandidateStatus.DISCOVERY_SCHEDULED,
        CandidateStatus.DISCOVERY_COMPLETED, CandidateStatus.TRAINING_SCHEDULED,
        CandidateStatus.TRAINING_COMPLETED, CandidateStatus.OFFLINE_STAGING,
        CandidateStatus.AWAITING_FIRST_SHIFT, CandidateStatus.HIRED,
        CandidateStatus.NDA, CandidateStatus.KNOWLEDGE_TEST,
        CandidateStatus.STAGING_SETUP, CandidateStatus.STAGING_ACTIVE,
        CandidateStatus.READY_FOR_HIRE
    ].includes(status);

    /**
     * Блок деталей показується з двох боків рішення, а звертання по різні боки
     * різне: до рішення вона кандидатка й на «ви», після — вже своя.
     * `isAcceptedOrBeyond` для цього не годиться — воно включає
     * INTERVIEW_COMPLETED і DECISION_PENDING, тобто «анкета ще на розгляді».
     */
    const isInTeam = ![
        CandidateStatus.INTERVIEW_COMPLETED,
        CandidateStatus.DECISION_PENDING,
    ].includes(status);
    // Без жодних даних точки блок не показується зовсім — і заголовок теж.
    const jobDetailsBody = isAcceptedOrBeyond ? await getJobDetailsText(candidate) : null;
    const jobDetails = jobDetailsBody
        ? `\n\n<b>${isInTeam ? "Твоя робота" : "Ваша майбутня робота"}:</b>\n${jobDetailsBody}`
        : "";

    switch (status) {
        case CandidateStatus.SCREENING: {
            // Те саме правило, що в нагадуванні й кнопці «Продовжити анкету».
            if (!isQuestionnaireOpen(candidate)) {
                // Запрошена або та, що чекає нового вікна, має бачити, як обрати
                // час: раніше /start показував їй «розглянемо анкету» без кнопки,
                // і записатися можна було лише зі старого повідомлення.
                const { FunnelStep } = await import("@prisma/client");
                if (canScheduleInterview(candidate)) {
                    text = candidate.currentStep === FunnelStep.INTERVIEW
                        ? CANDIDATE_TEXTS["candidate-waitlist-slots"]("співбесіди")
                        // Та сама назва, що в повідомленні-запрошенні (hr-service
                        // inviteCandidate): з філією, без точки — без рядка про локацію.
                        : CANDIDATE_TEXTS["candidate-interview-invitation"](candidate.location ? formatLocation(candidate.location, "in-city") : null);
                    kb.text(CANDIDATE_TEXTS["candidate-btn-choose-time"], "start_scheduling").row();
                } else {
                    text = CANDIDATE_TEXTS["candidate-success-screening"];
                }
                if (canContactStaff) kb.text("Написати нам", "contact_hr");
            } else {
                text = CANDIDATE_TEXTS["candidate-screening-unfinished"]();
                kb.text("Продовжити анкету", "resume_screening").row();
                kb.text("Почати спочатку", "restart_screening");
            }
            break;
        }

        case CandidateStatus.WAITLIST:
        case CandidateStatus.WAITLIST_HR:
        case CandidateStatus.WAITLIST_MENTOR: {
            const { FunnelStep } = await import("@prisma/client");
            // Черга на знайомство/навчання (WAITLIST_MENTOR або WAITLIST на
            // кроці TRAINING) — уже після апруву співбесіди. Запис на ці етапи
            // з бота прибрано (аудит 01.10.2026): кнопка «Обрати час» вела в
            // «Графік оновлюється… надішлемо сповіщення», а сповіщення ніхто
            // не надсилав. Такій кандидатці — той самий екран, що прийнятій:
            // власниця напише щодо навчання сама.
            if (status === CandidateStatus.WAITLIST_MENTOR || candidate.currentStep === FunnelStep.TRAINING) {
                text = CANDIDATE_TEXTS["candidate-accepted-welcome"]();
                kb.text("Написати нам", "contact_hr");
                break;
            }

            const isWaitingForSlots = candidate.currentStep === FunnelStep.INTERVIEW;

            text = isWaitingForSlots
                ? CANDIDATE_TEXTS["candidate-waitlist-slots"]("співбесіди")
                : CANDIDATE_TEXTS["candidate-success-waitlist"];

            if (isWaitingForSlots) kb.text(CANDIDATE_TEXTS["candidate-btn-choose-time"], "start_scheduling").row();
            if (canContactStaff) kb.text("Написати нам", "contact_hr");
            break;
        }

        case CandidateStatus.MANUAL_REVIEW:
            text = CANDIDATE_TEXTS["candidate-success-manual-review"];
            if (canContactStaff) kb.text("Написати нам", "contact_hr");
            break;

        case CandidateStatus.INTERVIEW_COMPLETED:
        case CandidateStatus.DECISION_PENDING:
            // Поки рішення немає — те саме, що воркер пише після автозавершення
            // співбесіди (interview-auto-complete.ts), з тим самим строком.
            text = (candidate.hrDecision
                ? `Приємно було познайомитися!\n\nВаша анкета на розгляді у HR — відповідь надішлемо найближчим часом.`
                : CANDIDATE_TEXTS["candidate-interview-thanks"]) + jobDetails;
            if (canContactStaff) kb.text("Написати нам", "contact_hr");
            break;

        case CandidateStatus.INTERVIEW_SCHEDULED: {
            const slot = candidate.interviewSlot;
            if (slot) {
                // Дата — у київській зоні, як і час: без timeZone сервер в UTC
                // показав би сусідній день для слота біля опівночі.
                const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
                const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                text = CANDIDATE_TEXTS["candidate-interview-scheduled"](dateStr, timeStr, candidate.googleMeetLink);
                if (hasInterviewStarted(slot.startTime)) text += `\n${CANDIDATE_TEXTS["candidate-interview-started-hint"]}`;
            } else text = "Вас записано на співбесіду.";
            kb = buildBookedInterviewKeyboard(candidate.interviewSlotId || "none", slot?.startTime, { canContactStaff });
            break;
        }

        // Після апруву співбесіди бот кандидатку більше нікуди не веде:
        // знайомство, навчання, NDA й оформлення ведуться у вебзастосунку,
        // а власник спілкується з нею особисто. Лишається один екран статусу
        // й можливість написати — повідомлення дзеркалиться в її анкету.
        // MENTOR_MANUAL — оффер надіслано (worker після рішення HR). Раніше
        // для нього не було гілки, і прийнята бачила «Анкета на розгляді».
        case CandidateStatus.MENTOR_MANUAL:
        case CandidateStatus.ACCEPTED:
        case CandidateStatus.DISCOVERY_SCHEDULED:
        case CandidateStatus.DISCOVERY_COMPLETED:
        case CandidateStatus.TRAINING_SCHEDULED:
        case CandidateStatus.TRAINING_COMPLETED:
        case CandidateStatus.NDA:
        case CandidateStatus.KNOWLEDGE_TEST:
        case CandidateStatus.READY_FOR_HIRE:
        case CandidateStatus.STAGING_SETUP:
        case CandidateStatus.STAGING_ACTIVE:
        case CandidateStatus.OFFLINE_STAGING:
        case CandidateStatus.AWAITING_FIRST_SHIFT: {
            text = CANDIDATE_TEXTS["candidate-accepted-welcome"]() + jobDetails;
            kb.text("Написати нам", "contact_hr");
            break;
        }

        case CandidateStatus.HIRED:
            // Сюди доходить лише та, в кого ще немає активного профілю: раніше
            // екран радив натиснути /start — і /start вів на цей самий екран.
            text = CANDIDATE_TEXTS["candidate-hired-no-cabinet"];
            break;

        case CandidateStatus.REJECTED:
            text = selectRejectedStatusText(candidate);
            if (canUseRecovery) {
                text += "\n\nРаніше наші повідомлення не доходили до вас у боті. Якщо хочете відновити зв’язок із командою — напишіть нам.";
                kb.text("Написати нам", "contact_recovery");
            }
            break;

        case CandidateStatus.BLOCKER:
            text = `<b>Зв’язок із ботом відновлено</b>\n\nРаніше наші повідомлення не доходили до вас, тому ми зупинили сповіщення, щоб не турбувати даремно.`;
            if (canUseRecovery) {
                text += "\n\nЩоб відновити контакт із командою або поставити запитання — натисніть кнопку нижче.";
                kb.text("Написати нам", "contact_recovery");
            }
            break;

        default:
            text = CANDIDATE_TEXTS["candidate-default-status"]();
            break;
    }

    await ScreenManager.renderScreen(ctx, text, kb, true);
}
