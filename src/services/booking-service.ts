import prisma from "../db/core.js";
import { FunnelStep } from "@prisma/client";
import { interviewRepository } from "../repositories/interview-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { googleCalendar } from "./google-calendar.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { getBirthDateRejection, getCandidateAge } from "../utils/candidate-age.js";
import { reactivateUnderageCandidateIfEligible } from "./underage-reactivation-service.js";

function toIsoOrUndefined(value: unknown): string | undefined {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    return undefined;
}

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
                description: `Кандидатка: ${candidateName}\nВік: ${candidate.birthDate ? getCandidateAge(candidate.birthDate) : 'Не вказано'}\nЛокація: ${candidate.location?.name || 'Не вказано'}\nTelegram: @${username || 'немає'}`,
                startTime,
                endTime
            });

            // 4. Update Candidate with Meet Link
            await candidateRepository.update(candidate.id, {
                googleMeetLink: googleEvent.meetLink || null,
                interviewSlot: { connect: { id: updatedSlot.id } },
                interviewWaitlistReason: null
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

    async cancelTrainingSlot(slotId: string, actorTelegramId?: number) {
        const slot = await trainingRepository.findSlotWithCandidate(slotId);
        if (!slot) return;

        if (actorTelegramId !== undefined) {
            const ownerTelegramId = slot.candidate?.user?.telegramId ?? slot.candidateDiscovery?.user?.telegramId;
            if (!ownerTelegramId || Number(ownerTelegramId) !== actorTelegramId) {
                throw new Error("FORBIDDEN_SLOT_ACCESS");
            }
        }

        if (slot.googleEventId) {
            await googleCalendar.deleteEvent(slot.googleEventId).catch(() => { });
        }

        if (slot.candidate) {
            await candidateRepository.update(slot.candidate.id, {
                trainingMeetLink: null,
                trainingSlot: { disconnect: true },
                // Recovery path for legacy inconsistent records where a mentor-stage
                // slot exists but currentStep drifted away from TRAINING.
                currentStep: FunnelStep.TRAINING,
            });

            logBusinessEvent({
                event: "candidate.training.cancelled",
                candidateId: slot.candidate.id,
                telegramId: slot.candidate.user?.telegramId,
                actorType: "system",
                actorRole: "system",
                stage: "TRAINING",
                result: "success",
                module: "booking-service",
                operation: "cancelTrainingSlot",
                safeContext: {
                    slotId,
                    hadCalendarEvent: Boolean(slot.googleEventId),
                },
            });
        }

        if (slot.candidateDiscovery) {
            await candidateRepository.update(slot.candidateDiscovery.id, {
                trainingMeetLink: null,
                discoverySlot: { disconnect: true },
                // Recovery path for legacy inconsistent records where a mentor-stage
                // slot exists but currentStep drifted away from TRAINING.
                currentStep: FunnelStep.TRAINING,
            });

            logBusinessEvent({
                event: "candidate.discovery.cancelled",
                candidateId: slot.candidateDiscovery.id,
                telegramId: slot.candidateDiscovery.user?.telegramId,
                actorType: "system",
                actorRole: "system",
                stage: "DISCOVERY",
                result: "success",
                module: "booking-service",
                operation: "cancelTrainingSlot",
                safeContext: {
                    slotId,
                    hadCalendarEvent: Boolean(slot.googleEventId),
                },
            });
        }

        return trainingRepository.updateSlot(slotId, {
            isBooked: false,
            candidate: { disconnect: true },
            candidateDiscovery: { disconnect: true },
            googleEventId: null
        });
    }

    async cancelDiscoverySlot(slotId: string, actorTelegramId?: number) {
        // Alias to cancelTrainingSlot since it now handles both candidate and candidateDiscovery
        return this.cancelTrainingSlot(slotId, actorTelegramId);
    }



    async bookDiscoverySlot(telegramId: number, slotId: string) {
        return prisma.$transaction(async (tx) => {
            const slot = await trainingRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked || slot.candidateId || slot.candidateDiscovery) {
                throw new Error("ALREADY_BOOKED");
            }

            const candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

            // --- SMART RESCHEDULE LOGIC for Discovery ---
            if (candidate.discoverySlotId) {
                logBusinessEvent({
                    event: "candidate.discovery.reschedule.started",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "DISCOVERY",
                    result: "pending",
                    module: "booking-service",
                    operation: "bookDiscoverySlot",
                    safeContext: {
                        oldSlotId: candidate.discoverySlotId,
                        newSlotId: slotId,
                    },
                });
                const oldSlot = await trainingRepository.findSlotById(candidate.discoverySlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn({ err: e, oldSlotId: candidate.discoverySlotId }, "Discovery reschedule calendar cleanup failed"));
                }
                // Unbook old slot
                await trainingRepository.updateSlot(candidate.discoverySlotId, {
                    isBooked: false,
                    candidateDiscovery: { disconnect: true },
                    googleEventId: null
                }, tx);
            }

            await candidateRepository.update(candidate.id, { status: "DISCOVERY_SCHEDULED" }, tx);

            const updatedSlot = await trainingRepository.updateSlot(slotId, {
                isBooked: true,
                candidateDiscovery: { connect: { id: candidate.id } }
            }, tx);

            // 3. Create Google Calendar Event for Discovery
            try {
                const startTime = updatedSlot.startTime;
                const endTime = updatedSlot.endTime;
                const candidateName = candidate.fullName || "Кандидат";

                const googleEvent = await googleCalendar.createEvent({
                    summary: `Знайомство: ${candidateName}`,
                    description: `Кандидатка: ${candidateName}\nВік: ${candidate.birthDate ? (new Date().getFullYear() - new Date(candidate.birthDate).getFullYear()) : 'Не вказано'}\nЛокація: ${candidate.location?.name || 'Не вказано'}\nTelegram: @${candidate.user?.username || 'немає'}`,
                    startTime,
                    endTime,
                    calendarType: 'training'
                });

                // 4. Update Candidate with Meet Link
                await candidateRepository.update(candidate.id, {
                    trainingMeetLink: googleEvent.meetLink || null,
                    discoverySlot: { connect: { id: updatedSlot.id } }
                }, tx);

                // Update slot with event ID
                if (googleEvent.eventId) {
                    await trainingRepository.updateSlot(updatedSlot.id, { googleEventId: googleEvent.eventId }, tx);
                }

                logBusinessEvent({
                    event: "candidate.discovery.booked",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "DISCOVERY",
                    result: "success",
                    module: "booking-service",
                    operation: "bookDiscoverySlot",
                    safeContext: {
                        slotId: updatedSlot.id,
                        startTime: toIsoOrUndefined(updatedSlot.startTime),
                        endTime: toIsoOrUndefined(updatedSlot.endTime),
                        rescheduled: Boolean(candidate.discoverySlotId),
                        calendarEventCreated: Boolean(googleEvent.eventId),
                    },
                });

                return { ...updatedSlot, googleMeetLink: googleEvent.meetLink };
            } catch (e) {
                logger.error({ err: e, candidateId: candidate.id, slotId }, "Failed to create Google Calendar event for discovery");
                logBusinessEvent({
                    event: "candidate.discovery.booked",
                    level: "warn",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "DISCOVERY",
                    result: "partial_success",
                    reasonCode: "CALENDAR_EVENT_CREATE_FAILED",
                    module: "booking-service",
                    operation: "bookDiscoverySlot",
                    safeContext: {
                        slotId: updatedSlot.id,
                        startTime: toIsoOrUndefined(updatedSlot.startTime),
                        endTime: toIsoOrUndefined(updatedSlot.endTime),
                        rescheduled: Boolean(candidate.discoverySlotId),
                    },
                    error: e,
                });
                return updatedSlot;
            }
        });
    }

    async bookTrainingSlot(telegramId: number, slotId: string) {
        return prisma.$transaction(async (tx) => {
            const slot = await trainingRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked || slot.candidateId || slot.candidateDiscovery) {
                throw new Error("ALREADY_BOOKED");
            }

            const candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

            // --- SMART RESCHEDULE LOGIC for Training ---
            if (candidate.trainingSlotId) {
                logBusinessEvent({
                    event: "candidate.training.reschedule.started",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "TRAINING",
                    result: "pending",
                    module: "booking-service",
                    operation: "bookTrainingSlot",
                    safeContext: {
                        oldSlotId: candidate.trainingSlotId,
                        newSlotId: slotId,
                    },
                });
                const oldSlot = await trainingRepository.findSlotById(candidate.trainingSlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn({ err: e, oldSlotId: candidate.trainingSlotId }, "Training reschedule calendar cleanup failed"));
                }
                // Unbook old slot
                await trainingRepository.updateSlot(candidate.trainingSlotId, {
                    isBooked: false,
                    candidate: { disconnect: true },
                    googleEventId: null
                }, tx);
            }

            await candidateRepository.update(candidate.id, { status: "TRAINING_SCHEDULED" }, tx);

            const updatedSlot = await trainingRepository.updateSlot(slotId, {
                isBooked: true,
                candidate: { connect: { id: candidate.id } }
            }, tx);

            // 3. Create Google Calendar Event for Training
            try {
                const startTime = updatedSlot.startTime;
                const endTime = updatedSlot.endTime;
                const candidateName = candidate.fullName || "Кандидат";

                const googleEvent = await googleCalendar.createEvent({
                    summary: `Навчання: ${candidateName}`,
                    description: `Кандидатка: ${candidateName}\nВік: ${candidate.birthDate ? (new Date().getFullYear() - new Date(candidate.birthDate).getFullYear()) : 'Не вказано'}\nTelegram: @${candidate.user?.username || 'немає'}`,
                    startTime,
                    endTime,
                    calendarType: 'training'
                });

                // 4. Update Candidate with Training Meet Link
                await candidateRepository.update(candidate.id, {
                    trainingMeetLink: googleEvent.meetLink || null,
                    trainingSlot: { connect: { id: updatedSlot.id } }
                }, tx);

                // Update slot with event ID
                if (googleEvent.eventId) {
                    await trainingRepository.updateSlot(updatedSlot.id, { googleEventId: googleEvent.eventId }, tx);
                }

                logBusinessEvent({
                    event: "candidate.training.booked",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "TRAINING",
                    result: "success",
                    module: "booking-service",
                    operation: "bookTrainingSlot",
                    safeContext: {
                        slotId: updatedSlot.id,
                        startTime: toIsoOrUndefined(updatedSlot.startTime),
                        endTime: toIsoOrUndefined(updatedSlot.endTime),
                        rescheduled: Boolean(candidate.trainingSlotId),
                        calendarEventCreated: Boolean(googleEvent.eventId),
                    },
                });

                return { ...updatedSlot, googleMeetLink: googleEvent.meetLink };
            } catch (e) {
                logger.error({ err: e, candidateId: candidate.id, slotId }, "Failed to create Google Calendar event for training");
                logBusinessEvent({
                    event: "candidate.training.booked",
                    level: "warn",
                    candidateId: candidate.id,
                    telegramId: telegramId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    stage: "TRAINING",
                    result: "partial_success",
                    reasonCode: "CALENDAR_EVENT_CREATE_FAILED",
                    module: "booking-service",
                    operation: "bookTrainingSlot",
                    safeContext: {
                        slotId: updatedSlot.id,
                        startTime: toIsoOrUndefined(updatedSlot.startTime),
                        endTime: toIsoOrUndefined(updatedSlot.endTime),
                        rescheduled: Boolean(candidate.trainingSlotId),
                    },
                    error: e,
                });
                return updatedSlot;
            }
        });
    }
}

export const bookingService = new BookingService();
