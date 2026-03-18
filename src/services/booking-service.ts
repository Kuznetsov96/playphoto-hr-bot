import prisma from "../db/core.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { googleCalendar } from "./google-calendar.js";
import logger from "../core/logger.js";

function getAge(birthDate: Date): number {
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
}

export class BookingService {
    async bookInterviewSlot(telegramId: number, slotId: string, username: string | undefined) {
        return prisma.$transaction(async (tx) => {
            const slot = await interviewRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked) {
                throw new Error("ALREADY_BOOKED");
            }

            const candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) {
                throw new Error("CANDIDATE_NOT_FOUND");
            }

            // Server-side protection from stale callback buttons and inconsistent states.
            if (candidate.status === "REJECTED" || candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE") {
                throw new Error("UNDERAGE_CANDIDATE");
            }
            if (candidate.birthDate && getAge(new Date(candidate.birthDate)) < 17) {
                throw new Error("UNDERAGE_CANDIDATE");
            }

            // --- SMART RESCHEDULE LOGIC ---
            // If candidate already has a booked slot, cancel it first
            if (candidate.interviewSlotId) {
                const oldSlot = await interviewRepository.findSlotById(candidate.interviewSlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn("Failed to delete old calendar event during reschedule"));
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
                description: `Кандидатка: ${candidateName}\nВік: ${candidate.birthDate ? (new Date().getFullYear() - new Date(candidate.birthDate).getFullYear()) : 'Не вказано'}\nЛокація: ${candidate.location?.name || 'Не вказано'}\nTelegram: @${username || 'немає'}`,
                startTime,
                endTime
            });

            // 4. Update Candidate with Meet Link
            await candidateRepository.update(candidate.id, {
                googleMeetLink: googleEvent.meetLink || null,
                interviewSlot: { connect: { id: updatedSlot.id } }
            }, tx);

            // Update slot with event ID if needed
            if (googleEvent.eventId) {
                await interviewRepository.updateSlot(updatedSlot.id, { googleEventId: googleEvent.eventId }, tx);
            }

            return { slot: updatedSlot, googleEvent };
        });
    }

    async cancelInterviewSlot(slotId: string) {
        const slot = await interviewRepository.findSlotWithCandidate(slotId);
        if (!slot) return;

        if (slot.googleEventId) {
            await googleCalendar.deleteEvent(slot.googleEventId).catch(() => { });
        }

        if (slot.candidate) {
            await candidateRepository.update(slot.candidate.id, { googleMeetLink: null });
        }

        return interviewRepository.updateSlot(slotId, {
            isBooked: false,
            candidate: { disconnect: true },
            googleEventId: null
        });
    }

    async cancelTrainingSlot(slotId: string) {
        const slot = await trainingRepository.findSlotWithCandidate(slotId);
        if (!slot) return;

        if (slot.googleEventId) {
            await googleCalendar.deleteEvent(slot.googleEventId).catch(() => { });
        }

        if (slot.candidate) {
            await candidateRepository.update(slot.candidate.id, { trainingMeetLink: null });
        }

        return trainingRepository.updateSlot(slotId, {
            isBooked: false,
            candidate: { disconnect: true },
            googleEventId: null
        });
    }

    async cancelDiscoverySlot(slotId: string) {
        const slot = await trainingRepository.findSlotWithCandidate(slotId);
        if (!slot) return;

        if (slot.googleEventId) {
            await googleCalendar.deleteEvent(slot.googleEventId).catch(() => { });
        }

        if (slot.candidate) {
            await candidateRepository.update(slot.candidate.id, { trainingMeetLink: null });
        }

        return trainingRepository.updateSlot(slotId, {
            isBooked: false,
            candidateDiscovery: { disconnect: true },
            googleEventId: null
        });
    }

    async bookDiscoverySlot(telegramId: number, slotId: string) {
        return prisma.$transaction(async (tx) => {
            const slot = await trainingRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked) throw new Error("ALREADY_BOOKED");

            const candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

            // --- SMART RESCHEDULE LOGIC for Discovery ---
            if (candidate.discoverySlotId) {
                const oldSlot = await trainingRepository.findSlotById(candidate.discoverySlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn("Failed to delete old discovery calendar event during reschedule"));
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

                return { ...updatedSlot, googleMeetLink: googleEvent.meetLink };
            } catch (e) {
                console.error("Failed to create Google Calendar event for discovery:", e);
                return updatedSlot;
            }
        });
    }

    async bookTrainingSlot(telegramId: number, slotId: string) {
        return prisma.$transaction(async (tx) => {
            const slot = await trainingRepository.findSlotById(slotId, tx);

            if (!slot || slot.isBooked) throw new Error("ALREADY_BOOKED");

            const candidate = await candidateRepository.findByTelegramId(telegramId, tx);

            if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

            // --- SMART RESCHEDULE LOGIC for Training ---
            if (candidate.trainingSlotId) {
                const oldSlot = await trainingRepository.findSlotById(candidate.trainingSlotId, tx);
                if (oldSlot && oldSlot.googleEventId) {
                    await googleCalendar.deleteEvent(oldSlot.googleEventId).catch(e => logger.warn("Failed to delete old training calendar event during reschedule"));
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

                return { ...updatedSlot, googleMeetLink: googleEvent.meetLink };
            } catch (e) {
                console.error("Failed to create Google Calendar event for training:", e);
                return updatedSlot;
            }
        });
    }
}

export const bookingService = new BookingService();
