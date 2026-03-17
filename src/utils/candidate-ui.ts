import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { CandidateStatus } from "@prisma/client";
import { ScreenManager } from "./screen-manager.js";
import { HR_NAME, MENTOR_NAME, KNOWLEDGE_BASE_LINK } from "../config.js";
import { extractFirstName } from "./string-utils.js";
import { getLocationDetails } from "./location-data-helper.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { cleanupMessages, trackMessage } from "./cleanup.js";

/**
 * Apple Style: Compact and readable job details
 */
function getJobDetailsText(candidate: any) {
    const loc = candidate.location;
    const staticInfo = getLocationDetails(loc?.name);

    const locationName = loc?.name || "Smile Park";
    const address = staticInfo?.address || loc?.address || "";
    const schedule = staticInfo?.schedule || loc?.schedule || "Гнучкий";
    const salary = staticInfo?.salary || loc?.salary || "20-30%";

    return `\n📍 <b>${locationName}</b>\n` +
        `🏠 ${address}\n` +
        `📅 ${schedule}\n` +
        `💰 ${salary}`;
}

export async function showCandidateStatus(ctx: MyContext, candidate: any) {
    const status = candidate.status;
    let text = "";
    const kb = new InlineKeyboard();

    const fullName = candidate.fullName || ctx.from?.first_name || "Кандидатко";
    const firstName = extractFirstName(fullName);

    // Dashboard logic: Show info for Accepted and beyond
    const isAcceptedOrBeyond = [
        CandidateStatus.INTERVIEW_COMPLETED, CandidateStatus.DECISION_PENDING,
        CandidateStatus.ACCEPTED, CandidateStatus.DISCOVERY_SCHEDULED,
        CandidateStatus.DISCOVERY_COMPLETED, CandidateStatus.TRAINING_SCHEDULED,
        CandidateStatus.TRAINING_COMPLETED, CandidateStatus.OFFLINE_STAGING,
        CandidateStatus.AWAITING_FIRST_SHIFT, CandidateStatus.HIRED,
        CandidateStatus.NDA, CandidateStatus.KNOWLEDGE_TEST,
        CandidateStatus.STAGING_SETUP, CandidateStatus.STAGING_ACTIVE,
        CandidateStatus.READY_FOR_HIRE
    ].includes(status);

    const jobDetails = isAcceptedOrBeyond ? `\n\n<b>Твоя майбутня робота:</b>${getJobDetailsText(candidate)}` : "";

    switch (status) {
        case CandidateStatus.SCREENING: {
            const { FunnelStep } = await import("@prisma/client");
            const isFinished = candidate.currentStep === FunnelStep.INTERVIEW ||
                candidate.currentStep === FunnelStep.TRAINING ||
                candidate.notificationSent ||
                !!candidate.source;

            if (isFinished) {
                text = CANDIDATE_TEXTS["candidate-success-screening"];
                kb.text("👩‍💼 Написати HR", "contact_hr");
            } else {
                text = CANDIDATE_TEXTS["candidate-screening-unfinished"](firstName);
                kb.text("📝 Продовжити анкету", "resume_screening").row();
                kb.text("🔄 Почати спочатку", "restart_screening");
            }
            break;
        }

        case CandidateStatus.WAITLIST: {
            const { FunnelStep } = await import("@prisma/client");
            const isWaitingForSlots = candidate.currentStep === FunnelStep.INTERVIEW || candidate.currentStep === FunnelStep.TRAINING;
            const typeText = candidate.currentStep === FunnelStep.TRAINING ? "знайомства та навчання" : "співбесіди";

            text = isWaitingForSlots
                ? CANDIDATE_TEXTS["candidate-waitlist-slots"](firstName, typeText)
                : CANDIDATE_TEXTS["candidate-success-waitlist"];

            if (isWaitingForSlots) kb.text("🗓️ Перевірити вільний час", candidate.currentStep === FunnelStep.TRAINING ? "start_training_scheduling" : "start_scheduling").row();
            kb.text("👩‍💼 Написати HR", "contact_hr");
            break;
        }

        case CandidateStatus.MANUAL_REVIEW:
            text = CANDIDATE_TEXTS["candidate-success-manual-review"];
            kb.text("👩‍💼 Написати HR", "contact_hr");
            break;

        case CandidateStatus.INTERVIEW_COMPLETED:
        case CandidateStatus.DECISION_PENDING:
            text = `🌸 <b>${firstName}</b>, приємно було познайомитися! 😊\n\nТвоя анкета на розгляді у HR. Очікуй на відповідь найближчим часом. ✨` + jobDetails;
            kb.text("👩‍💼 Написати HR", "contact_hr");
            break;

        case CandidateStatus.INTERVIEW_SCHEDULED: {
            const slot = candidate.interviewSlot;
            if (slot) {
                const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
                const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                text = CANDIDATE_TEXTS["candidate-interview-scheduled"](dateStr, timeStr, candidate.googleMeetLink);
            } else text = `🌸 <b>${firstName}</b>, ти записана на співбесіду!`;
            kb.text("🗓️ Перенести", `reschedule_booking_${candidate.interviewSlotId || 'none'}`).row()
                .text("❌ Скасувати", `cancel_booking_${candidate.interviewSlotId || 'none'}`).row()
                .text("👩‍💼 Написати HR", "contact_hr");
            break;
        }

        case CandidateStatus.ACCEPTED: {
            if (candidate.materialsSent) {
                text = CANDIDATE_TEXTS["candidate-accepted-materials"](firstName) + jobDetails;
                kb.text("🗓️ Обрати час знайомства", "start_training_scheduling").row();
                if (KNOWLEDGE_BASE_LINK) kb.url("📚 База знань", KNOWLEDGE_BASE_LINK).row();
            } else {
                text = CANDIDATE_TEXTS["candidate-accepted-welcome"](firstName) + jobDetails;
            }
            kb.text("👩‍🏫 Написати наставниці", "contact_hr");
            break;
        }

        case CandidateStatus.DISCOVERY_SCHEDULED:
        case CandidateStatus.TRAINING_SCHEDULED: {
            const slot = status === CandidateStatus.DISCOVERY_SCHEDULED ? candidate.discoverySlot : candidate.trainingSlot;
            const typeLabel = status === CandidateStatus.DISCOVERY_SCHEDULED ? "знайомство" : "навчання";
            if (slot) {
                const dateStr = slot.startTime.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
                const timeStr = slot.startTime.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                text = CANDIDATE_TEXTS["candidate-training-scheduled"](typeLabel, dateStr, timeStr, candidate.trainingMeetLink);
            } else text = `🌸 <b>${firstName}</b>, ти записана на ${typeLabel}. Очікуй деталей! ✨`;
            text += jobDetails;
            if (KNOWLEDGE_BASE_LINK) kb.url("📚 База знань", KNOWLEDGE_BASE_LINK).row();
            kb.text("🗓️ Перенести", `reschedule_training_${(status === CandidateStatus.DISCOVERY_SCHEDULED ? candidate.discoverySlotId : candidate.trainingSlotId) || 'none'}`).row()
                .text("❌ Скасувати", `cancel_training_${(status === CandidateStatus.DISCOVERY_SCHEDULED ? candidate.discoverySlotId : candidate.trainingSlotId) || 'none'}`).row()
                .text("👩‍🏫 Написати наставниці", "contact_hr");
            break;
        }

        case CandidateStatus.DISCOVERY_COMPLETED:
            text = CANDIDATE_TEXTS["candidate-discovery-completed"](firstName) + jobDetails;
            kb.text("👩‍🏫 Написати наставниці", "contact_hr");
            break;

        case CandidateStatus.TRAINING_COMPLETED:
        case CandidateStatus.NDA:
            if (!candidate.ndaConfirmedAt) {
                text = CANDIDATE_TEXTS["candidate-training-completed-nda"](firstName) + jobDetails;
                kb.text("📝 Ознайомитись з NDA", `send_nda_${candidate.id}`).row();
            } else {
                // Should move to KNOWLEDGE_TEST, but fallback just in case
                text = CANDIDATE_TEXTS["candidate-training-completed-quiz"](firstName) + jobDetails;
                kb.text("🚀 Перейти до тесту", "start_quiz").row();
            }
            kb.text("👩‍🏫 Написати наставниці", "contact_hr");
            break;

        case CandidateStatus.KNOWLEDGE_TEST:
            text = CANDIDATE_TEXTS["candidate-training-completed-quiz"](firstName) + jobDetails;
            kb.text("🚀 Перейти до тесту", "start_quiz").row();
            kb.text("👩‍🏫 Написати наставниці", "contact_hr");
            break;

        case CandidateStatus.READY_FOR_HIRE: {
            text = CANDIDATE_TEXTS["admin-staging-passed-activation"](firstName);
            kb.text("✨ Активувати профіль", "start_onboarding_data").row();
            kb.text("👨‍💼 Написати Адміну", "contact_hr");
            break;
        }

        case CandidateStatus.STAGING_SETUP:
        case CandidateStatus.STAGING_ACTIVE:
        case CandidateStatus.OFFLINE_STAGING:
        case CandidateStatus.AWAITING_FIRST_SHIFT: {
            const dateStr = candidate.firstShiftDate ? new Date(candidate.firstShiftDate).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : "";
            const timeStr = candidate.firstShiftTime || "";
            if (dateStr && (timeStr || status === CandidateStatus.STAGING_ACTIVE)) {
                text = CANDIDATE_TEXTS["status-card-staging-confirmed"](candidate.location?.name || candidate.city || "нашій локації", dateStr, timeStr || "15:00-17:00");
                if (candidate.location?.googleMapsLink) text += `\n🗺️ <a href="${candidate.location.googleMapsLink}">На мапі</a>`;
                if (candidate.firstShiftPartner?.user?.username) kb.url("💬 Написати напарнику", `https://t.me/${candidate.firstShiftPartner.user.username}`).row();
                kb.text("🗓️ Змінити дату", "start_staging_selection").row();
                kb.text("❌ Не зможу прийти", `cancel_staging_${candidate.id}`).row();
            } else {
                text = CANDIDATE_TEXTS["status-card-staging-pending"] + jobDetails;
                kb.text("🗓️ Обрати дату", "start_staging_selection").row();
            }
            kb.text("👨‍💼 Написати Адміну", "contact_hr");
            break;
        }

        case CandidateStatus.REJECTED:
            text = CANDIDATE_TEXTS["candidate-rejected"];
            break;

        default:
            text = CANDIDATE_TEXTS["candidate-default-status"](firstName);
            kb.text("👩‍💼 Написати HR", "contact_hr");
            break;
    }

    await ScreenManager.renderScreen(ctx, text, kb, true);
}
