import { Prisma, CandidateStatus } from "@prisma/client";
import type { TrainingSlot, TrainingSession } from "@prisma/client";
import prisma from "../db/core.js";

export class TrainingRepository {
    async findSlotsByDateRange(start: Date, end: Date): Promise<any[]> {
        return prisma.trainingSlot.findMany({
            where: {
                startTime: { gte: start, lte: end }
            },
            include: { 
                candidate: {
                    include: {
                        location: true,
                        user: true
                    }
                },
                candidateDiscovery: {
                    include: {
                        location: true,
                        user: true
                    }
                }
            },
            orderBy: { startTime: 'asc' }
        });
    }

    async findActiveBookedSlotsByDateRange(start: Date, end: Date): Promise<any[]> {
        const slots = await this.findSlotsByDateRange(start, end);
        
        // Filter out slots where the candidate has already moved past the scheduled stage
        return slots.filter(slot => {
            if (!slot.isBooked) return true; // Keep free slots

            const cand = slot.candidate;
            const discCand = slot.candidateDiscovery;

            // Non-exclusive logic: show if EITHER candidate is still in scheduled status
            let isActiveTraining = cand && cand.status === CandidateStatus.TRAINING_SCHEDULED;
            let isActiveDiscovery = discCand && (discCand.status as any) === "DISCOVERY_SCHEDULED";

            if (isActiveTraining || isActiveDiscovery) return true;

            return false; // Both candidates moved on or no candidate linked
        });
    }

    async findActiveSlots(): Promise<any[]> {
        return prisma.trainingSlot.findMany({
            where: { isBooked: false, startTime: { gte: new Date() } },
            include: { candidate: true, candidateDiscovery: true },
            orderBy: { startTime: 'asc' },
            take: 40
        });
    }

    async findFutureSlots(): Promise<any[]> {
        const slots = await prisma.trainingSlot.findMany({
            where: {
                OR: [
                    { startTime: { gte: new Date() } },
                    { 
                        isBooked: true,
                        OR: [
                            { candidate: { status: CandidateStatus.TRAINING_SCHEDULED } },
                            { candidateDiscovery: { status: "DISCOVERY_SCHEDULED" as any } }
                        ]
                    }
                ]
            },
            include: { 
                candidate: true,
                candidateDiscovery: true
            },
            orderBy: { startTime: 'asc' }
        });

        // Filter out ghost slots (booked but candidate moved on)
        // Filter out ghost slots (booked but candidate moved on)
        return slots.filter(slot => {
            if (!slot.isBooked) return true;
            const cand = slot.candidate;
            const discCand = slot.candidateDiscovery;
            
            let isActiveTraining = cand && cand.status === CandidateStatus.TRAINING_SCHEDULED;
            let isActiveDiscovery = discCand && (discCand.status as any) === "DISCOVERY_SCHEDULED";

            return isActiveTraining || isActiveDiscovery;
        });
    }

    async findSlotWithCandidate(id: string, tx?: Prisma.TransactionClient): Promise<any | null> {
        return (tx || prisma).trainingSlot.findUnique({
            where: { id },
            include: { 
                candidate: { include: { user: true, location: true } }, 
                candidateDiscovery: { include: { user: true, location: true } } 
            }
        });
    }

    async findSlotById(id: string, tx?: Prisma.TransactionClient): Promise<any | null> {
        return (tx || prisma).trainingSlot.findUnique({
            where: { id },
            include: { 
                candidate: { include: { user: true, location: true } }, 
                candidateDiscovery: { include: { user: true, location: true } } 
            }
        });
    }

    async updateSlot(id: string, data: Prisma.TrainingSlotUpdateInput, tx?: Prisma.TransactionClient): Promise<any> {
        return (tx || prisma).trainingSlot.update({
            where: { id },
            data,
            include: { candidate: { include: { user: true, location: true } } }
        });
    }

    async createSession(data: Prisma.TrainingSessionCreateInput): Promise<TrainingSession> {
        return prisma.trainingSession.create({
            data
        });
    }

    async createSlot(data: Prisma.TrainingSlotCreateInput): Promise<TrainingSlot> {
        return prisma.trainingSlot.create({
            data
        });
    }

    async deleteSlot(id: string): Promise<TrainingSlot> {
        return prisma.trainingSlot.delete({
            where: { id }
        });
    }

    async countBookedSlotsByDateRange(start: Date, end: Date): Promise<number> {
        const slots = await this.findActiveBookedSlotsByDateRange(start, end);
        return slots.filter(s => s.isBooked).length;
    }

    async findForReminder(field: 'reminded6h' | 'reminded10m' | 'reminded5mMentor', threshold: Date) {
        return prisma.trainingSlot.findMany({
            where: {
                isBooked: true,
                [field]: false,
                // Widen the window to catch recently started slots if worker was delayed
                startTime: { lte: threshold, gt: new Date(Date.now() - 10 * 60 * 1000) },
                OR: [
                    { candidate: { status: CandidateStatus.TRAINING_SCHEDULED } },
                    { candidateDiscovery: { status: "DISCOVERY_SCHEDULED" as any } }
                ]
            },
            include: { 
                candidate: { include: { user: true, location: true } },
                candidateDiscovery: { include: { user: true, location: true } }
            }
        });
    }

    async findOverdueBooked(status: CandidateStatus) {
        return prisma.trainingSlot.findMany({
            where: {
                isBooked: true,
                endTime: { lt: new Date() }, // Wait until END of slot
                remindedCompletion: false,
                candidate: { status }
            },
            include: { candidate: true, candidateDiscovery: true }
        });
    }

    async updateMany(where: Prisma.TrainingSlotWhereInput, data: Prisma.TrainingSlotUpdateManyMutationInput) {
        return prisma.trainingSlot.updateMany({ where, data });
    }

    async findActiveSessionsAfter(date: Date) {
        return prisma.trainingSession.findMany({
            where: { startTime: { gte: date } },
            include: { slots: true },
            orderBy: { startTime: 'asc' }
        });
    }

    async findSessionById(id: string) {
        return prisma.trainingSession.findUnique({
            where: { id },
            include: { slots: true }
        });
    }

    async deleteSession(id: string) {
        return prisma.trainingSession.delete({
            where: { id }
        });
    }
}

export const trainingRepository = new TrainingRepository();
