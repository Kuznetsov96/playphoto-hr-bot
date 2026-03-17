import { interviewRepository } from "../repositories/interview-repository.js";
import logger from "../core/logger.js";

export class InterviewService {
    /**
     * Creates a batch of slots for a session.
     * @param start Start date/time
     * @param end End date/time
     * @param slotDuration Duration of each slot in minutes (default 20)
     */
    async createSessionWithSlots(start: Date, end: Date, slotDuration: number = 20) {
        if (end <= start) {
            throw new Error("End time must be after start time");
        }

        // 1. Check for ANY overlaps (allows back-to-back)
        const overlap = await interviewRepository.findFirstOverlap(start, end);

        // Apple Style: Smart Overlap Check
        // Only block if the slot is booked and the candidate is still in the active interview status.
        // If the slot is empty or the candidate already moved on, we allow the operation.
        const isStrictlyOccupied = overlap && overlap.isBooked && overlap.candidate && overlap.candidate.status === "INTERVIEW_SCHEDULED";

        if (isStrictlyOccupied) {
            throw new Error(`✨ This time slot is already occupied. Please choose another window. 📅`);
        }

        // 2. Clean up existing free or ghost slots in this range to avoid duplicates
        const prisma = (await import("../db/core.js")).default;
        await prisma.interviewSlot.deleteMany({
            where: {
                AND: [
                    { startTime: { lt: new Date(end.getTime() - 1000) } },
                    { endTime: { gt: new Date(start.getTime() + 1000) } },
                    { 
                        OR: [
                            { isBooked: false },
                            { candidate: { status: { not: "INTERVIEW_SCHEDULED" } } }
                        ]
                    }
                ]
            }
        });

        const session = await interviewRepository.createSession({ startTime: start, endTime: end });

        const slots = [];
        let current = new Date(start);
        
        // Ensure at least one slot is created if the window is valid
        if (new Date(current.getTime() + slotDuration * 60 * 1000) > end) {
            slots.push({ start: new Date(current), end: new Date(end) });
        } else {
            while (current < end) {
                const slotEnd = new Date(current.getTime() + slotDuration * 60 * 1000);
                if (slotEnd > end) break;
                slots.push({ start: new Date(current), end: slotEnd });
                current = slotEnd;
            }
        }

        let createdCount = 0;
        for (const s of slots) {
            try {
                await interviewRepository.createSlot({
                    startTime: s.start,
                    endTime: s.end,
                    isBooked: false,
                    sessionId: session.id
                });
                createdCount++;
            } catch (e) {
                logger.error({ err: e, slot: s }, "Error creating interview slot");
            }
        }

        return { session, createdCount };
    }

    /**
     * Creates a single slot without an explicit session.
     */
    async createSingleSlot(start: Date, duration: number = 20, candidateId?: string) {
        const end = new Date(start.getTime() + duration * 60 * 1000);

        // 1. Check for ANY overlaps (allows back-to-back)
        const overlap = await interviewRepository.findFirstOverlap(start, end);
        const isStrictlyOccupied = overlap && overlap.isBooked && overlap.candidate && overlap.candidate.status === "INTERVIEW_SCHEDULED";

        if (isStrictlyOccupied) {
            throw new Error(`✨ This time slot is already occupied. Please choose another window. 📅`);
        }

        // 2. Clean up existing free or ghost slots in this range to avoid duplicates
        const prisma = (await import("../db/core.js")).default;
        await prisma.interviewSlot.deleteMany({
            where: {
                AND: [
                    { startTime: { lt: new Date(end.getTime() - 1000) } },
                    { endTime: { gt: new Date(start.getTime() + 1000) } },
                    { 
                        OR: [
                            { isBooked: false },
                            { candidate: { status: { not: "INTERVIEW_SCHEDULED" } } }
                        ]
                    }
                ]
            }
        });

        const session = await interviewRepository.createSession({ startTime: start, endTime: end });
        const slot = await interviewRepository.createSlot({
            startTime: start,
            endTime: end,
            isBooked: !!candidateId,
            sessionId: session.id,
            ...(candidateId ? { candidate: { connect: { id: candidateId } } } : {})
        });
        return slot;
    }

    async getActiveSlots() {
        return interviewRepository.findActiveSlots();
    }

    async getAllSessions() {
        return interviewRepository.findAllSessions();
    }

    async bookSlot(slotId: string, candidateId: string) {
        return interviewRepository.updateSlot(slotId, {
            isBooked: true,
            candidate: { connect: { id: candidateId } }
        });
    }

    /**
     * Safely updates a session's interval
     */
    async updateSessionInterval(sessionId: string, newStart: Date, newEnd: Date, slotDuration: number = 20) {
        const session = await interviewRepository.findSessionById(sessionId);
        if (!session) throw new Error("SESSION_NOT_FOUND");

        // 1. Check if any slots outside the NEW range are already booked
        const bookedOutside = session.slots.filter(s => s.isBooked && (s.startTime < newStart || s.endTime > newEnd));
        if (bookedOutside.length > 0) {
            throw new Error("CANNOT_UPDATE_BOOKED_SLOTS");
        }

        // 2. Delete all unbooked slots
        await interviewRepository.deleteUnbookedSlots(sessionId);

        // 3. Create missing slots in the new range
        const existingBooked = session.slots.filter(s => s.isBooked);
        
        let current = new Date(newStart);
        let createdCount = 0;
        while (current < newEnd) {
            const slotEnd = new Date(current.getTime() + slotDuration * 60 * 1000);
            if (slotEnd > newEnd) break;

            // Check if this window is already covered by a booked slot
            const isOverlap = existingBooked.some(b => 
                (current >= b.startTime && current < b.endTime) ||
                (slotEnd > b.startTime && slotEnd <= b.endTime)
            );

            if (!isOverlap) {
                await interviewRepository.createSlot({
                    startTime: new Date(current),
                    endTime: slotEnd,
                    isBooked: false,
                    sessionId: session.id
                });
                createdCount++;
            }
            current = slotEnd;
        }

        // 4. Update session header
        await interviewRepository.updateSessionHeader(sessionId, { startTime: newStart, endTime: newEnd });

        return { createdCount };
    }
}

export const interviewService = new InterviewService();
