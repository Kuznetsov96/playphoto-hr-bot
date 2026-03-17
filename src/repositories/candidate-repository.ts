import { Prisma, CandidateStatus, FunnelStep } from "@prisma/client";
import type { Candidate, User, Location, StaffProfile, TrainingSlot, InterviewSlot, Message } from "@prisma/client";
import prisma from "../db/core.js";

export type CandidateWithRelations = Candidate & {
    user: User;
    location: Location | null;
    firstShiftPartner: (StaffProfile & { user: User | null }) | null;
    trainingSlot: TrainingSlot | null;
    discoverySlot: TrainingSlot | null;
    interviewSlot: InterviewSlot | null;
    messages: Message[];
};

export class CandidateRepository {
    async findByTelegramId(telegramId: number, tx?: Prisma.TransactionClient): Promise<CandidateWithRelations | null> {
        return (tx || prisma).candidate.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations | null>;
    }

    async findByUserId(userId: string): Promise<CandidateWithRelations | null> {
        return prisma.candidate.findUnique({
            where: { userId },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations | null>;
    }

    async findById(id: string, tx?: Prisma.TransactionClient): Promise<CandidateWithRelations | null> {
        return (tx || prisma).candidate.findUnique({
            where: { id },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations | null>;
    }

    async countAll(): Promise<number> {
        return prisma.candidate.count();
    }

    async findByStatus(status: CandidateStatus, isWaitlisted: boolean = false): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: { status, isWaitlisted },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async countByStatus(status: CandidateStatus | CandidateStatus[], isWaitlisted?: boolean): Promise<number> {
        return prisma.candidate.count({
            where: {
                status: Array.isArray(status) ? { in: status } : status,
                ...(isWaitlisted !== undefined ? { isWaitlisted } : {})
            }
        });
    }

    async countByStatusAndSlot(status: CandidateStatus, interviewSlotId: string | null, extraWhere: Prisma.CandidateWhereInput = {}): Promise<number> {
        return prisma.candidate.count({
            where: { status, interviewSlotId, ...extraWhere }
        });
    }

    async countHiredAfter(date: Date): Promise<number> {
        return prisma.candidate.count({
            where: {
                status: { in: [CandidateStatus.ACCEPTED, CandidateStatus.HIRED] },
                interviewCompletedAt: { gte: date }
            }
        });
    }

    async countUnread(): Promise<number> {
        return prisma.candidate.count({
            where: { hasUnreadMessage: true }
        });
    }

    async countUnreadByScope(scope: "HR" | "MENTOR"): Promise<number> {
        const mentorStatuses = [
            CandidateStatus.ACCEPTED, 
            CandidateStatus.REJECTED,
            CandidateStatus.DISCOVERY_SCHEDULED, 
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED
        ];

        const candidates = await prisma.candidate.findMany({
            where: {
                hasUnreadMessage: true,
                messages: { some: { scope } },
                ...(scope === "HR" ? {
                    status: { notIn: mentorStatuses },
                    OR: [
                        { hrDecision: null as any },
                        { hrDecision: { not: "ACCEPTED" } }
                    ]
                } : {})
            },
            select: {
                id: true,
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: { scope: true }
                }
            }
        });

        return candidates.filter(c => c.messages.length > 0 && c.messages[0]?.scope === scope).length;
    }

    async findUnreadByScope(scope: "HR" | "MENTOR"): Promise<CandidateWithRelations[]> {
        // Aggressive status-based filtering for HR scope
        const mentorStatuses = [
            CandidateStatus.ACCEPTED, 
            CandidateStatus.REJECTED,
            CandidateStatus.DISCOVERY_SCHEDULED, 
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED
        ];

        const candidates = await prisma.candidate.findMany({
            where: {
                hasUnreadMessage: true,
                messages: { some: { scope } },
                // If scope is HR, strictly exclude mentor statuses
                ...(scope === "HR" ? {
                    status: { notIn: mentorStatuses },
                    OR: [
                        { hrDecision: null as any },
                        { hrDecision: { not: "ACCEPTED" } }
                    ]
                } : {})
            },
            include: { 
                user: true, 
                location: true, 
                firstShiftPartner: { include: { user: true } }, 
                discoverySlot: true, 
                trainingSlot: true, 
                interviewSlot: true, 
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                } 
            },
            orderBy: { user: { createdAt: 'desc' } }
        }) as unknown as CandidateWithRelations[];

        return candidates.filter(c => c.messages.length > 0 && c.messages[0]?.scope === scope);
    }

    async countByOfflineStagingStep(step: FunnelStep): Promise<number> {
        return prisma.candidate.count({
            where: {
                status: { in: [CandidateStatus.OFFLINE_STAGING, CandidateStatus.AWAITING_FIRST_SHIFT] },
                currentStep: step
            }
        });
    }

    async update(id: string, data: Prisma.CandidateUpdateInput, tx?: Prisma.TransactionClient): Promise<CandidateWithRelations> {
        const client = tx || prisma;
        const candidate = await client.candidate.update({
            where: { id },
            data,
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as CandidateWithRelations;

        // If status changed, sync channel access in background
        if (data.status !== undefined && candidate.user?.telegramId) {
            import("../services/access-service.js").then(({ accessService }) => {
                accessService.syncUserAccess(candidate.user.telegramId).catch(() => {});
            }).catch(() => {});
        }

        return candidate;
    }

    async findByCityAndStatus(city: string, status: CandidateStatus, isWaitlisted: boolean = false, extraWhere: Prisma.CandidateWhereInput = {}): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: { city, status, isWaitlisted, ...extraWhere },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async findByQuery(query: string): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: {
                OR: [
                    { fullName: { contains: query } },
                    { user: { username: { contains: query } } }
                ]
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true },
            take: 20
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async findByStatusWithUser(status: CandidateStatus | CandidateStatus[], whereExtra: Prisma.CandidateWhereInput = {}): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: {
                status: Array.isArray(status) ? { in: status } : status,
                ...whereExtra
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true },
            orderBy: { user: { createdAt: 'desc' } }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async updateMany(where: Prisma.CandidateWhereInput, data: Prisma.CandidateUpdateManyMutationInput) {
        return prisma.candidate.updateMany({
            where,
            data
        });
    }

    async findForDecisionNotification(delay: Date) {
        return prisma.candidate.findMany({
            where: {
                status: CandidateStatus.INTERVIEW_COMPLETED,
                hrDecision: { not: null },
                notificationSent: false,
                interviewCompletedAt: { lte: delay }
            },
            include: { user: true }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async upsert(args: Prisma.CandidateUpsertArgs): Promise<CandidateWithRelations> {
        return prisma.candidate.upsert({
            ...args,
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations>;
    }

    async delete(id: string) {
        return prisma.candidate.delete({ where: { id } });
    }

    async deleteMany(where: Prisma.CandidateWhereInput) {
        return prisma.candidate.deleteMany({ where });
    }

    async deleteRelatedData(candidateId: string) {
        await prisma.$transaction(async (tx) => {
            await tx.interviewSlot.updateMany({
                where: { candidateId },
                data: { isBooked: false, candidateId: null }
            });
            await tx.trainingSlot.updateMany({
                where: { candidateId },
                data: { isBooked: false, candidateId: null }
            });
            
            // Unlink lead if exists
            await tx.lead.updateMany({
                where: { candidateId },
                data: { candidateId: null }
            });

            await tx.message.deleteMany({ where: { candidateId } });
            await tx.application.deleteMany({ where: { candidateId } });
            await tx.candidate.delete({ where: { id: candidateId } });
        });
    }

    async countByLocationAndStatus(locationId: string, status: CandidateStatus) {
        return prisma.candidate.count({ where: { locationId, status } });
    }

    async getFunnelStats(city?: string, locationId?: string): Promise<Record<string, number>> {
        const where: Prisma.CandidateWhereInput = {};
        if (locationId) {
            where.locationId = locationId;
        } else if (city) {
            where.city = city;
        }
        const statuses = [
            'SCREENING', 'WAITLIST', 'MANUAL_REVIEW', 'INTERVIEW_SCHEDULED',
            'INTERVIEW_COMPLETED', 'DECISION_PENDING', 'ACCEPTED',
            'TRAINING_SCHEDULED', 'TRAINING_COMPLETED', 'OFFLINE_STAGING',
            'AWAITING_FIRST_SHIFT', 'HIRED', 'REJECTED'
        ] as const;

        const counts: Record<string, number> = {};
        for (const status of statuses) {
            counts[status] = await prisma.candidate.count({
                where: { ...where, status: status as any }
            });
        }
        counts['TOTAL'] = await prisma.candidate.count({ where });
        return counts;
    }

    async countCreatedAfter(date: Date, city?: string, locationId?: string): Promise<number> {
        const where: Prisma.CandidateWhereInput = {
            user: { createdAt: { gte: date } }
        };
        if (locationId) {
            where.locationId = locationId;
        } else if (city) {
            where.city = city;
        }
        return prisma.candidate.count({ where });
    }

    async findOfflineStagingUnassigned(): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: {
                status: { in: [CandidateStatus.OFFLINE_STAGING, CandidateStatus.AWAITING_FIRST_SHIFT] },
                currentStep: FunnelStep.FIRST_SHIFT,
                firstShiftPartnerId: null
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true },
            orderBy: { user: { createdAt: 'asc' } }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async findAwaitingNDA(): Promise<CandidateWithRelations[]> {
        return prisma.candidate.findMany({
            where: {
                status: CandidateStatus.TRAINING_COMPLETED,
                ndaConfirmedAt: null,
                ndaSentAt: { not: null }
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true },
            orderBy: { ndaSentAt: 'asc' }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async findAwaitingNDAReminder(delayHours: number): Promise<CandidateWithRelations[]> {
        const delayDate = new Date();
        delayDate.setHours(delayDate.getHours() - delayHours);

        return prisma.candidate.findMany({
            where: {
                status: CandidateStatus.TRAINING_COMPLETED,
                ndaConfirmedAt: null,
                ndaSentAt: { lte: delayDate }
            } as any,
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as Promise<CandidateWithRelations[]>;
    }

    async getDistinctCities(): Promise<string[]> {
        const result = await prisma.candidate.findMany({
            where: { city: { not: null } },
            select: { city: true },
            distinct: ['city'],
            orderBy: { city: 'asc' }
        });
        return result.map(r => r.city).filter(Boolean) as string[];
    }

    async findBirthdaysToday(day: number, month: number): Promise<CandidateWithRelations[]> {
        // Since birthDate is a DateTime field, we fetch candidates with birthDate and filter by day/month
        // This is safer across different DB engines than raw SQL extracts
        const candidates = await prisma.candidate.findMany({
            where: {
                birthDate: { not: null },
                user: { staffProfile: null } // Exclude those who are already staff
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        });

        return candidates.filter(c => {
            const bday = new Date(c.birthDate!);
            return bday.getUTCDate() === day && (bday.getUTCMonth() + 1) === month;
        }) as unknown as CandidateWithRelations[];
    }
}

export const candidateRepository = new CandidateRepository();
