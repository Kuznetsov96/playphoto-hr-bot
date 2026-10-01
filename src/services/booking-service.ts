import prisma from "../db/core.js";
import { FunnelStep } from "@prisma/client";
import { interviewRepository } from "../repositories/interview-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { googleCalendar } from "./google-calendar.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { getBirthDateRejection, getCandidateAge } from "../utils/candidate-age.js";
import { reactivateUnderageCandidateIfEligible } from "./underage-reactivation-service.js";
import { formatLocation } from "../utils/location-label.js";

export class BookingService {
    async bookInterviewSlot(telegramId: number, slotId: string, username: string | undefined) {
        return prisma.$transaction(async (tx) => {
            const slot = await interviewRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked) {
                throw new Error("ALREADY_BOOKED");
            }

            let candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) {
                throw new Error("CANDIDATE_NOT_FOUND");
            }

            if (candidate.gender === "male") {
                throw new Error("MALE_CANDIDATE");
            }

            const ageRejection = getBirthDateRejection(candidate.birthDate, candidate.location);
            if (ageRejection === "UNDERAGE") {
                throw new Error("UNDERAGE_CANDIDATE");
            }
            if (ageRejection === "AGE_LIMIT") {
                throw new Error("AGE_LIMIT_CANDIDATE");
            }
            if (candidate.hrDecision === "AGE_LIMIT") {
                throw new Error("AGE_LIMIT_CANDIDATE");
            }

            // Server-side recovery from stale interview buttons sent before an
            // underage rejection became eligible by date.
            if (candidate.status === "REJECTED" || candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE") {
                const reactivation = await reactivateUnderageCandidateIfEligible(candidate, "interview_booking", tx);
                if (!reactivation) {
                    throw new Error(candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE" ? "UNDERAGE_CANDIDATE" : "CANDIDATE_NOT_ACTIVE");
                }
                if (reactivation.mode === "RESUME_SCREENING" || reactivation.mode === "MANUAL_REVIEW") {
                    throw new Error("SCREENING_INCOMPLETE");
                }
                candidate = reactivation.candidate;
            }

            // --- SMART RESCHEDULE LOGIC ---
            // If candidate already has a booked slot, cancel it first
            if (candidate.interviewSlotId) {
                logBusinessEvent({
                    event: "candidate.interview.reschedule.started",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "INTERVIEW",
                    result: "pending",
                    module: "booking-service",
                    operation: "bookInterviewSlot",
                    safeContext: {
                        oldSlotId: candidate.interviewSlotId,
                        newSlotId: slotId,
                    },
                });
                const oldSlot = await interviewRepository.findSlotById(candidate.interviewSlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn({ err: e, oldSlotId: candidate.interviewSlotId }, "Interview reschedule calendar cleanup failed"));
                }
                // Unbook old slot
                await interviewRepository.updateSlot(candidate.interviewSlotId, {
                    isBooked: false,
                    candidate: { disconnect: true },
                    googleEventId: null
                }, tx);
            }

            // 1. Update Candidate Status
            await candidateRepository.update(candidate.id, { status: "INTERVIEW_SCHEDULED" }, tx);

            // 2. Book Slot
            const updatedSlot = await interviewRepository.updateSlot(slotId, {
                isBooked: true,
                candidate: { connect: { id: candidate.id } }
            }, tx);

            if (!updatedSlot) throw new Error("SLOT_UPDATE_FAILED");

            // 3. Create Google Calendar Event
            const startTime = updatedSlot.startTime;
            const endTime = updatedSlot.endTime;
            const candidateName = updatedSlot.candidate?.fullName || "Кандидат";

            const googleEvent = await googleCalendar.createInterviewEvent({
                summary: `Співбесіда: ${candidateName}`,
                description: `Кандидатка: ${candidateName}\nВік: ${candidate.birthDate ? getCandidateAge(candidate.birthDate) : 'Не вказано'}\nЛокація: ${candidate.location ? formatLocation(candidate.location, 'listing') : 'Не вказано'}\nTelegram: @${username || 'немає'}`,
                startTime,
                endTime
            });

            // 4. Update Candidate with Meet Link
            await candidateRepository.update(candidate.id, {
                googleMeetLink: googleEvent.meetLink || null,
                interviewSlot: { connect: { id: updatedSlot.id } },
                interviewWaitlistReason: null,
                // Успешная бронь закрывает "нема вільних слотів" — веб-инбокс
                // не должен продолжать показывать устаревший сигнал.
                noSlotsAt: null
            }, tx);

            // Update slot with event ID if needed
            if (googleEvent.eventId) {
                await interviewRepository.updateSlot(updatedSlot.id, { googleEventId: googleEvent.eventId }, tx);
            }

            logBusinessEvent({
                event: "candidate.interview.booked",
                candidateId: candidate.id,
                telegramId: telegramId,
                actorType: "candidate",
                actorRole: "candidate",
                stage: "INTERVIEW",
                result: "success",
                module: "booking-service",
                operation: "bookInterviewSlot",
                safeContext: {
                    slotId: updatedSlot.id,
                    startTime: updatedSlot.startTime.toISOString(),
                    endTime: updatedSlot.endTime.toISOString(),
                    rescheduled: Boolean(candidate.interviewSlotId),
                    calendarEventCreated: Boolean(googleEvent.eventId),
                },
            });

            return { slot: updatedSlot, googleEvent };
        });
    }

    async cancelInterviewSlot(slotId: string, actorTelegramId?: number) {
        const slot = await interviewRepository.findSlotWithCandidate(slotId);
        if (!slot) return;

        if (actorTelegramId !== undefined) {
            const ownerTelegramId = slot.candidate?.user?.telegramId;
            if (!ownerTelegramId || Number(ownerTelegramId) !== actorTelegramId) {
                throw new Error("FORBIDDEN_SLOT_ACCESS");
            }
        }

        if (slot.googleEventId) {
            await googleCalendar.deleteEvent(slot.googleEventId).catch(() => { });
        }

        if (slot.candidate) {
            await candidateRepository.update(slot.candidate.id, {
                googleMeetLink: null,
                interviewSlot: { disconnect: true },
                // Recovery path for legacy inconsistent records where the interview
                // slot exists but currentStep was left in a later funnel stage.
                currentStep: FunnelStep.INTERVIEW,
            });

            logBusinessEvent({
                event: "candidate.interview.cancelled",
                candidateId: slot.candidate.id,
                telegramId: slot.candidate.user?.telegramId,
                actorType: "system",
                actorRole: "system",
                stage: "INTERVIEW",
                result: "success",
                module: "booking-service",
                operation: "cancelInterviewSlot",
                safeContext: {
                    slotId,
                    hadCalendarEvent: Boolean(slot.googleEventId),
                },
            });
        }

        return interviewRepository.updateSlot(slotId, {
            isBooked: false,
            candidate: { disconnect: true },
            googleEventId: null
        });
    }

    // Запис кандидатки на знайомство й навчання (bookDiscoverySlot,
    // bookTrainingSlot, cancelTrainingSlot) прибрано разом із кнопками
    // (аудит 01.10.2026): ці етапи власниця веде у вебаппі, бот тут мовчить.
}

export const bookingService = new BookingService();
