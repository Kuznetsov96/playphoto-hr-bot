import { InlineKeyboard, type Api } from "grammy";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { bookingService } from "./booking-service.js";
import {
    findAvailableInterviewSlots,
    releaseCanonicalInterviewSlot,
    type CanonicalReleaseReason,
} from "./canonical-interview-slots.js";
import { cleanupUserSessionMessages, trackUserMessage } from "../utils/cleanup.js";
import { handleBlockedCandidate, isBotBlocked } from "../utils/bot-blocked.js";
import { buildSlotSelectionKeyboard } from "../utils/interview-slot-keyboard.js";

/**
 * Перенос співбесіди командою вебаппа RESCHEDULE_INTERVIEW (рішення власника
 * 01.10.2026). Дві причини з контракту:
 *  - HR_MISSED — зустріч не відбулася з нашого боку;
 *  - CANDIDATE_ASKED — кандидатка сама попросила інший час.
 *
 * Вебапп видає команду, поки кандидатка записана (INTERVIEW_SCHEDULED) або
 * поки співбесіду автоматично закрито без рішення HR (INTERVIEW_COMPLETED,
 * hrDecision = null).
 */
export const INTERVIEW_RESCHEDULE_REASONS = ["HR_MISSED", "CANDIDATE_ASKED"] as const;
export type InterviewRescheduleReason = typeof INTERVIEW_RESCHEDULE_REASONS[number];

export function isInterviewRescheduleReason(code: unknown): code is InterviewRescheduleReason {
    return typeof code === "string" && (INTERVIEW_RESCHEDULE_REASONS as readonly string[]).includes(code);
}

const RELEASE_REASON: Record<InterviewRescheduleReason, CanonicalReleaseReason> = {
    HR_MISSED: "hr_missed",
    CANDIDATE_ASKED: "candidate_asked_reschedule",
};

const SLOTS_TEXT: Record<InterviewRescheduleReason, string> = {
    HR_MISSED: CANDIDATE_TEXTS["candidate-interview-reschedule-hr-missed"],
    CANDIDATE_ASKED: CANDIDATE_TEXTS["candidate-interview-reschedule-asked"],
};

const NO_SLOTS_TEXT: Record<InterviewRescheduleReason, string> = {
    HR_MISSED: CANDIDATE_TEXTS["candidate-interview-reschedule-hr-missed-no-slots"],
    CANDIDATE_ASKED: CANDIDATE_TEXTS["candidate-interview-reschedule-asked-no-slots"],
};

/** Той самий код черги, що ставить «Обрати час» без слотів (handlers/booking.ts). */
const INTERVIEW_WAITLIST_REASON_NO_SLOTS = "NO_SLOTS_AVAILABLE";

export type InterviewRescheduleResult =
    | { ok: true; delivered: boolean; slotsOffered: number }
    | { ok: false; reason: "not_found" | "state_conflict" | "send_failed" };

/** Статуси, з яких вебапп має право перенести співбесіду. */
function isReschedulable(candidate: { status: CandidateStatus; hrDecision: string | null }): boolean {
    if (candidate.hrDecision) return false;
    return candidate.status === CandidateStatus.INTERVIEW_SCHEDULED ||
        candidate.status === CandidateStatus.INTERVIEW_COMPLETED;
}

/**
 * Повтор команди після «RESCHEDULE_NOT_SENT»: перенос уже записано (слот
 * звільнено, кандидатка шукає час), не дійшло лише повідомлення. Без цього
 * повтор бачив би SCREENING і падав state_conflict — рекрутерка отримала б
 * код «стан не той» замість «повідомлення не надіслано».
 */
function isAlreadyRescheduled(candidate: {
    status: CandidateStatus;
    hrDecision: string | null;
    currentStep: FunnelStep | null;
    interviewSlotId: string | null;
}): boolean {
    return candidate.status === CandidateStatus.SCREENING &&
        !candidate.hrDecision &&
        candidate.currentStep === FunnelStep.INTERVIEW &&
        !candidate.interviewSlotId;
}

export async function rescheduleInterviewByCommand(
    api: Api,
    candidateId: string,
    reason: InterviewRescheduleReason,
    options: { isRetry: boolean },
): Promise<InterviewRescheduleResult> {
    const candidate = await candidateRepository.findById(candidateId);
    if (!candidate) return { ok: false, reason: "not_found" };

    const telegramId = Number(candidate.user.telegramId);
    const resumeAfterFailedSend = options.isRetry && isAlreadyRescheduled(candidate);

    if (!isReschedulable(candidate) && !resumeAfterFailedSend) {
        logger.warn(
            { candidateId, status: candidate.status, hrDecision: candidate.hrDecision },
            "rescheduleInterviewByCommand: candidate is not in a reschedulable state, nothing changed",
        );
        // Вебапп бачив іншу стадію — наздоганяємо дзеркало, як і в запрошенні.
        candidateRepository.requestMirrorPush(candidate.id);
        return { ok: false, reason: "state_conflict" };
    }

    // Слоти читаємо ДО будь-яких змін: збій API тут лишає запис цілим, і
    // команда просто повториться. Звільнений нижче слот кандидатки в цей
    // список не потрапить — і не повинен: вона просить інший час.
    const slots = await findAvailableInterviewSlots();

    if (!resumeAfterFailedSend) {
        // Порядок той самий, що в скасуванні кандидаткою (handlers/booking.ts):
        // спершу вебапп (власник слотів), потім локальне дзеркало. Збій
        // вебаппа кидається далі — локальне скасування без веб-скасування
        // лишило б слот зайнятим для всіх інших.
        await releaseCanonicalInterviewSlot(telegramId, RELEASE_REASON[reason]);
        if (candidate.interviewSlotId) {
            await bookingService.cancelInterviewSlot(candidate.interviewSlotId);
        }
    }

    const now = new Date();
    // Стан «шукає час», як у запрошеної: SCREENING + notificationSent. Саме
    // його бачать canScheduleInterview (кнопки й /start) і invite-reminder —
    // нагадування через 24 год і закриття через 48 год працюють як у
    // звичайному запрошенні, бо interviewInvitedAt ставиться заново.
    const finalPatch = slots.length > 0
        ? {
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INTERVIEW,
            notificationSent: true,
            isWaitlisted: false,
            interviewWaitlistReason: null,
            interviewInvitedAt: now,
            interviewInviteReminderSentAt: null,
        }
        // Слотів немає — та сама черга, що й «Обрати час» без слотів:
        // noSlotsAt піднімає кандидатку в секції «потребує вікон» у вебі.
        // Запрошення тут немає (вибирати нічого), тож invite-reminder її не
        // чіпає; нові вікна прийдуть розсилкою.
        : {
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INTERVIEW,
            notificationSent: false,
            isWaitlisted: false,
            interviewWaitlistReason: INTERVIEW_WAITLIST_REASON_NO_SLOTS,
            interviewWaitlistedAt: now,
            noSlotsAt: now,
            interviewInvitedAt: null,
            interviewInviteReminderSentAt: null,
        };

    // INTERVIEW_* → SCREENING guard воронки напряму не пускає; легальний шлях
    // — через WAITLIST_HR (з INTERVIEW_* дозволено, а з WAITLIST_HR дозволено
    // SCREENING). Обидва кроки в одній транзакції: проміжного WAITLIST_HR
    // ніхто не бачить, а збій другого кроку не лишає кандидатку в черзі HR.
    // interviewCompletedAt знімається: співбесіди фактично не було, а ця
    // відмітка — доказ для переходу в менторський етап.
    await prisma.$transaction(async (tx) => {
        if (!resumeAfterFailedSend) {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.WAITLIST_HR,
                currentStep: FunnelStep.INTERVIEW,
                interviewCompletedAt: null,
            }, tx);
        }
        await candidateRepository.update(candidate.id, finalPatch, tx);
    });

    logBusinessEvent({
        event: "candidate.interview.rescheduled_by_webapp",
        candidateId: candidate.id,
        telegramId: candidate.user.telegramId,
        actorType: "system",
        actorRole: "system",
        stage: "INTERVIEW",
        result: "success",
        module: "interview-reschedule-service",
        operation: "rescheduleInterviewByCommand",
        safeContext: {
            reason,
            fromStatus: candidate.status,
            slotsOffered: slots.length,
            resumeAfterFailedSend,
        },
    });

    try {
        // Старі кнопки запису/переносу ведуть у вже звільнений слот — прибираємо.
        await cleanupUserSessionMessages(api, telegramId);
        const msg = slots.length > 0
            ? await api.sendMessage(telegramId, SLOTS_TEXT[reason], {
                parse_mode: "HTML",
                reply_markup: buildSlotSelectionKeyboard(slots, "book_slot_", "no_slots_fit"),
            })
            : await api.sendMessage(telegramId, NO_SLOTS_TEXT[reason], {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("Написати нам", "contact_hr"),
            });
        if (msg) await trackUserMessage(telegramId, msg.message_id);
    } catch (error) {
        if (isBotBlocked(error)) {
            // Як у воркерах: кандидатка закрила чат — архів BLOCKER, а
            // команда застосована (повтор нічого б не змінив).
            await handleBlockedCandidate(api, candidate.id, candidate.fullName || "Candidate");
            return { ok: true, delivered: false, slotsOffered: slots.length };
        }
        logger.warn({ err: error, candidateId, telegramId }, "rescheduleInterviewByCommand: message not sent");
        return { ok: false, reason: "send_failed" };
    }

    return { ok: true, delivered: true, slotsOffered: slots.length };
}
