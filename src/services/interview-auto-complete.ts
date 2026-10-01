import { CandidateStatus } from "@prisma/client";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { logBusinessEvent } from "../core/log-events.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { isBotBlocked, handleBlockedCandidate } from "../utils/bot-blocked.js";
import logger from "../core/logger.js";

/**
 * Автозавершення співбесід, чий слот уже скінчився (крок 7 воркера).
 *
 * Раніше кандидатка в цей момент не отримувала нічого — і далі йшов
 * найдовший мовчазний відрізок воронки. Тепер пишемо «Дякуємо за розмову»,
 * але лише тим, кому HR ще не ухвалив рішення: HR часто вирішує просто під
 * час зустрічі, і відмова чи прийняття йдуть окремим повідомленням — подяка
 * «рішення надішлемо протягом доби» після відмови суперечила б уже надісланому
 * (аудит 01.10.2026, текст погоджено власником).
 *
 * Однократність тримає вибірка: findOverdueBooked бере лише INTERVIEW_SCHEDULED
 * з remindedCompletion=false, а тут кандидатка переходить в INTERVIEW_COMPLETED
 * і слот позначається — до відправки, щоб збій Telegram не повторював тік.
 */
export async function autoCompleteOverdueInterviews(api: any): Promise<void> {
    const completedSlots = await interviewRepository.findOverdueBooked(CandidateStatus.INTERVIEW_SCHEDULED);

    for (const slot of completedSlots) {
        const candidate = slot.candidate;
        if (!candidate) continue;
        try {
            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.INTERVIEW_COMPLETED,
                interviewCompletedAt: slot.endTime
            });
            logBusinessEvent({
                event: "candidate.interview.auto_completed",
                candidateId: candidate.id,
                actorType: "system",
                actorRole: "system",
                stage: "INTERVIEW_COMPLETED",
                result: "success",
                module: "worker",
                operation: "processAutoCompleteInterview",
                safeContext: {
                    slotId: slot.id,
                    completedAt: slot.endTime.toISOString(),
                },
            });

            await interviewRepository.updateSlot(slot.id, { remindedCompletion: true });
        } catch (e) {
            continue;
        }

        if (candidate.hrDecision || !candidate.user?.telegramId) continue;

        try {
            await api.sendMessage(Number(candidate.user.telegramId), CANDIDATE_TEXTS["candidate-interview-thanks"], { parse_mode: "HTML" });
        } catch (e: any) {
            if (isBotBlocked(e)) {
                await handleBlockedCandidate(api, candidate.id, candidate.fullName || "Candidate");
            } else {
                logger.warn({ err: e, candidateId: candidate.id }, "Post-interview thanks was not delivered");
            }
        }
    }
}
