import type { FirstShiftOnboardingCase, FirstShiftOnboardingStep, Prisma } from "@prisma/client";
import prisma from "../db/core.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";

export type FirstShiftOnboardingCaseWithRelations = FirstShiftOnboardingCase & {
    candidate: Prisma.CandidateGetPayload<{
        include: { user: true; location: true; firstShiftPartner: { include: { user: true } } };
    }>;
    steps: FirstShiftOnboardingStep[];
};

export class FirstShiftOnboardingRepository {
    async findCaseByCandidateId(candidateId: string) {
        return prisma.firstShiftOnboardingCase.findUnique({
            where: { candidateId },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as Promise<FirstShiftOnboardingCaseWithRelations | null>;
    }

    async findActiveCaseByCandidateId(candidateId: string) {
        return prisma.firstShiftOnboardingCase.findFirst({
            where: {
                candidateId,
                status: { in: ["OPEN", "IN_PROGRESS", "CLOSING", "PENDING_FINAL"] },
            },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as Promise<FirstShiftOnboardingCaseWithRelations | null>;
    }

    async findActiveCaseByTopicId(topicId: number, chatId?: number) {
        return prisma.firstShiftOnboardingCase.findFirst({
            where: {
                topicId,
                ...(chatId ? { chatId: BigInt(chatId) } : {}),
                status: { in: ["OPEN", "IN_PROGRESS", "CLOSING", "PENDING_FINAL"] },
            },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as Promise<FirstShiftOnboardingCaseWithRelations | null>;
    }

    async createCase(candidateId: string, steps: Prisma.FirstShiftOnboardingStepCreateWithoutCaseInput[]) {
        return prisma.firstShiftOnboardingCase.create({
            data: {
                candidateId,
                steps: { create: steps },
            },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as Promise<FirstShiftOnboardingCaseWithRelations>;
    }

    async updateCase(id: string, data: Prisma.FirstShiftOnboardingCaseUpdateInput) {
        return prisma.firstShiftOnboardingCase.update({
            where: { id },
            data,
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as Promise<FirstShiftOnboardingCaseWithRelations>;
    }

    async updateStep(id: string, data: Prisma.FirstShiftOnboardingStepUpdateInput) {
        return prisma.firstShiftOnboardingStep.update({
            where: { id },
            data,
        });
    }

    async findUpcomingCandidatesForAutoOpen(now: Date, windowEnd: Date) {
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        return prisma.candidate.findMany({
            where: {
                status: { in: ["AWAITING_FIRST_SHIFT", "HIRED"] },
                firstShiftDate: { gte: startOfDay, lte: endOfDay },
                firstShiftOnboardingCase: null,
            },
            include: {
                user: true,
                location: true,
                firstShiftPartner: { include: { user: true } },
            },
        }).then(candidates => candidates.filter(candidate => {
            const shiftTime = candidate.firstShiftTime || getShiftTimeFromLocationSchedule(candidate.location?.schedule, candidate.firstShiftDate || new Date());
            const shiftStart = this.resolveShiftStart(candidate.firstShiftDate, shiftTime);
            if (!shiftStart) return true;
            return shiftStart <= windowEnd;
        }));
    }

    private resolveShiftStart(date?: Date | null, time?: string | null) {
        if (!date) return null;
        const match = time?.match(/(\d{1,2})[:.](\d{2})?/);
        const result = new Date(date);
        if (match) {
            result.setHours(Number(match[1]), Number(match[2] || 0), 0, 0);
        }
        return result;
    }
}

export const firstShiftOnboardingRepository = new FirstShiftOnboardingRepository();
