import type { FirstShiftOnboardingCase, FirstShiftOnboardingStep, Prisma } from "@prisma/client";
import prisma from "../db/core.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";
import { createKyivDate } from "../utils/bot-utils.js";

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
        const { startOfDay, endOfDay } = this.getKyivDayRange(now);

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
        const { year, month, day } = this.getKyivCalendarParts(date);
        if (match) {
            return createKyivDate(year, month - 1, day, Number(match[1]), Number(match[2] || 0));
        }
        return createKyivDate(year, month - 1, day, 0, 0);
    }

    private getKyivDayRange(date: Date) {
        const { year, month, day } = this.getKyivCalendarParts(date);
        return {
            startOfDay: createKyivDate(year, month - 1, day, 0, 0),
            endOfDay: createKyivDate(year, month - 1, day, 23, 59),
        };
    }

    private getKyivCalendarParts(date: Date) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Kyiv",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(date);

        return {
            year: Number(parts.find((part) => part.type === "year")?.value),
            month: Number(parts.find((part) => part.type === "month")?.value),
            day: Number(parts.find((part) => part.type === "day")?.value),
        };
    }
}

export const firstShiftOnboardingRepository = new FirstShiftOnboardingRepository();
