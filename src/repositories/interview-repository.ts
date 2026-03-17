import { CandidateStatus, Prisma } from "@prisma/client";
import prisma from "../db/core.js";

export class InterviewRepository {
    async createSession(data: { startTime: Date; endTime: Date }) {
        return prisma.interviewSession.create({
            data
        });
    }

    async createSlot(data: { startTime: Date; endTime: Date; isBooked?: boolean; sessionId: string }) {
        return prisma.interviewSlot.create({
            data
        });
    }

    async findSlotWithCandidate(id: string, tx?: Prisma.TransactionClient) {
        return (tx || prisma).interviewSlot.findUnique({
            where: { id },
            include: { candidate: { include: { user: true, location: true } } }
        });
    }

    async findSlotById(id: string, tx?: Prisma.TransactionClient) {
        return (tx || prisma).interviewSlot.findUnique({
            where: { id },
            include: { candidate: { include: { user: true, location: true } } }
        });
    }

    async findSessionById(id: string) {
        return prisma.interviewSession.findUnique({
            where: { id },
            include: { slots: true }
        });
    }

    async findAllSessions() {
        return prisma.interviewSession.findMany({
            include: { slots: true },
            orderBy: { startTime: 'desc' }
        });
    }

    async findActiveSlots() {
        return prisma.interviewSlot.findMany({
            where: { isBooked: false, startTime: { gte: new Date() } },
            orderBy: { startTime: 'asc' },
            include: { interviewSession: true }
        });
    }

    async countBookedInRange(start: Date, end: Date, whereExtra: Prisma.InterviewSlotWhereInput = {}): Promise<number> {
        return prisma.interviewSlot.count({
            where: {
                isBooked: true,
                startTime: { gte: start, lte: end },
                ...whereExtra
            }
        });
    }

    async findBookedAfter(date: Date) {
        return prisma.interviewSlot.findMany({
            where: { startTime: { gte: date } },
            select: { startTime: true },
            orderBy: { startTime: 'asc' }
        });
    }

    async findWithCandidateInWindow(start: Date, end: Date) {
        return prisma.interviewSlot.findMany({
            where: { 
                startTime: { gte: start, lt: end },
                OR: [
                    { isBooked: false },
                    { 
                        isBooked: true, 
                        candidate: {
                            OR: [
                                { status: CandidateStatus.INTERVIEW_SCHEDULED },
                                { status: CandidateStatus.INTERVIEW_COMPLETED },
                                { status: CandidateStatus.DECISION_PENDING }
                            ]
                        }
                    }
                ]
            },
            include: { candidate: { include: { user: true, location: true } } },
            orderBy: { startTime: 'asc' }
        });
    }

    async updateSlot(id: string, data: Prisma.InterviewSlotUpdateInput, tx?: Prisma.TransactionClient) {
        return (tx || prisma).interviewSlot.update({
            where: { id },
            data,
            include: { candidate: { include: { user: true, location: true } } }
        });
    }

    async deleteSlot(id: string) {
        return prisma.interviewSlot.delete({
            where: { id }
        });
    }

    async deleteSession(id: string) {
        return prisma.interviewSession.delete({
            where: { id }
        });
    }

    async findForReminder(field: 'reminded6h' | 'reminded10m' | 'reminded2mHR', threshold: Date) {
        return prisma.interviewSlot.findMany({
            where: {
                isBooked: true,
                [field]: false,
                // Widen the window to catch recently started slots if worker was delayed
                startTime: { lte: threshold, gt: new Date(Date.now() - 10 * 60 * 1000) },
                candidate: { 
                    status: CandidateStatus.INTERVIEW_SCHEDULED,
                    hrDecision: null
                }
            },
            include: { candidate: { include: { user: true, location: true } } }
        });
    }

    async findOverdueBooked(status: CandidateStatus) {
        return prisma.interviewSlot.findMany({
            where: {
                isBooked: true,
                endTime: { lt: new Date() },
                remindedCompletion: false,
                candidate: { status }
            },
            include: { candidate: true }
        });
    }

    async updateMany(where: Prisma.InterviewSlotWhereInput, data: Prisma.InterviewSlotUpdateManyMutationInput) {
        return prisma.interviewSlot.updateMany({ where, data });
    }

    async findActiveSessionsAfter(date: Date) {
        return prisma.interviewSession.findMany({
            where: { startTime: { gte: date } },
            include: { slots: true },
            orderBy: { startTime: 'asc' }
        });
    }

    async findFirstByCandidateId(candidateId: string) {
        return prisma.interviewSlot.findFirst({ where: { candidateId } });
    }

    async findFirstOverlap(start: Date, end: Date) {
        return prisma.interviewSlot.findFirst({
            where: {
                AND: [
                    { startTime: { lt: new Date(end.getTime() - 1000) } },
                    { endTime: { gt: new Date(start.getTime() + 1000) } }
                ]
            },
            include: { candidate: true }
        });
    }

    async deleteUnbookedSlots(sessionId: string) {
        return prisma.interviewSlot.deleteMany({
            where: { sessionId, isBooked: false }
        });
    }

    async updateSessionHeader(id: string, data: Prisma.InterviewSessionUpdateInput) {
        return prisma.interviewSession.update({
            where: { id },
            data
        });
    }
}

export const interviewRepository = new InterviewRepository();
