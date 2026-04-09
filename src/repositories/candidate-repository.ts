import { Prisma, CandidateStatus, FunnelStep } from "@prisma/client";
import type { Candidate, User, Location, StaffProfile, TrainingSlot, InterviewSlot, Message } from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import {
    buildNextCandidateFunnelState,
    InvalidCandidateTransitionError,
    normalizeCandidateFunnelPatch,
    validateCandidateFunnelTransition,
    type CandidateFunnelSnapshot,
} from "../services/candidate-funnel-guard.js";
import { logAuditEvent, logBusinessEvent } from "../core/log-events.js";

const LEGACY_READABLE_CANDIDATE_STATUSES: CandidateStatus[] = [
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST,
    CandidateStatus.MANUAL_REVIEW,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
    CandidateStatus.ACCEPTED,
    CandidateStatus.REJECTED,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER
];

function isUnknownCandidateStatusError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("not found in enum 'CandidateStatus'");
}

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
    private async getFunnelSnapshot(client: Prisma.TransactionClient | typeof prisma, id: string): Promise<CandidateFunnelSnapshot | null> {
        return client.candidate.findUnique({
            where: { id },
            select: {
                id: true,
                fullName: true,
                status: true,
                currentStep: true,
                hrDecision: true,
                isWaitlisted: true,
                notificationSent: true,
                materialsSent: true,
                interviewCompletedAt: true,
                interviewSlotId: true,
                discoverySlotId: true,
                trainingSlotId: true,
            }
        }) as unknown as Promise<CandidateFunnelSnapshot | null>;
    }

    private validateFunnelPatch(oldCandidate: CandidateFunnelSnapshot, data: Prisma.CandidateUpdateInput | Prisma.CandidateUpdateManyMutationInput) {
        const normalizedData = normalizeCandidateFunnelPatch(oldCandidate, data);
        const transition = buildNextCandidateFunnelState(oldCandidate, normalizedData);
        validateCandidateFunnelTransition(transition);
        return { normalizedData, transition };
    }

    private touchPipeline<T extends Prisma.CandidateUpdateInput | Prisma.CandidateUpdateManyMutationInput>(data: T): T {
        return {
            ...data,
            pipelineTouchedAt: new Date(),
        };
    }

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

        const buildWhere = (useLegacyHrFallback: boolean): Prisma.CandidateWhereInput => ({
            hasUnreadMessage: true,
            messages: { some: { scope } },
            ...(scope === "HR" ? {
                ...(useLegacyHrFallback
                    ? { status: { in: LEGACY_READABLE_CANDIDATE_STATUSES } }
                    : { status: { notIn: mentorStatuses } }),
                OR: [
                    { hrDecision: null as any },
                    { hrDecision: { not: "ACCEPTED" } }
                ]
            } : {})
        });

        let candidates: CandidateWithRelations[];
        try {
            candidates = await prisma.candidate.findMany({
                where: buildWhere(false),
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
        } catch (error) {
            if (scope !== "HR" || !isUnknownCandidateStatusError(error)) {
                throw error;
            }

            logger.warn({ err: error }, "Falling back to legacy-safe HR unread status filter");
            candidates = await prisma.candidate.findMany({
                where: buildWhere(true),
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
        }

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
        const oldCandidate = await this.getFunnelSnapshot(client, id);
        if (!oldCandidate) {
            throw new Error(`Candidate ${id} not found`);
        }
        let normalizedData = this.touchPipeline(data);
        let transition = buildNextCandidateFunnelState(oldCandidate, normalizedData);

        try {
            const validation = this.validateFunnelPatch(oldCandidate, normalizedData);
            normalizedData = this.touchPipeline(validation.normalizedData as Prisma.CandidateUpdateInput);
            transition = validation.transition;
        } catch (error) {
            if (error instanceof InvalidCandidateTransitionError) {
                logBusinessEvent({
                    event: "candidate.transition.blocked",
                    level: "warn",
                    candidateId: id,
                    actorType: "system",
                    actorRole: "system",
                    stage: oldCandidate.status,
                    result: "blocked",
                    reasonCode: error.reasonCode,
                    module: "candidate-repository",
                    operation: "update",
                    safeContext: {
                        fromStatus: error.context.oldState.status,
                        toStatus: error.context.nextState.status,
                        fromStep: error.context.oldState.currentStep,
                        toStep: error.context.nextState.currentStep,
                        changedFields: error.context.changedFields,
                    },
                    error,
                });
                logAuditEvent({
                    event: "candidate.transition.blocked",
                    actorType: "system",
                    actorRole: "system",
                    candidateId: id,
                    result: "failed",
                    reasonCode: error.reasonCode,
                    module: "candidate-repository",
                    operation: "update",
                    safeContext: {
                        fromStatus: error.context.oldState.status,
                        toStatus: error.context.nextState.status,
                        changedFields: error.context.changedFields,
                    },
                    error,
                });
            }
            throw error;
        }

        // Auto-track status change time
        if ((normalizedData as any).status !== undefined) {
            (normalizedData as any).statusChangedAt = new Date();
        }
        const candidate = await client.candidate.update({
            where: { id },
            data: normalizedData,
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as CandidateWithRelations;

        if (oldCandidate) {
            const changes: Record<string, { from: unknown; to: unknown }> = {};
            if ((normalizedData as any).status !== undefined && oldCandidate.status !== candidate.status) {
                changes.status = { from: oldCandidate.status, to: candidate.status };
                
                // --- AUTOMATIC TIMELINE TRACKING ---
                import("../services/timeline-service.js").then(({ timelineService }) => {
                    timelineService.trackStatusChange(candidate, oldCandidate.status, candidate.status, 'SYSTEM').catch(() => {});
                }).catch(() => {});
            }
            if (oldCandidate.interviewSlotId !== candidate.interviewSlotId) {
                changes.interviewSlotId = { from: oldCandidate.interviewSlotId, to: candidate.interviewSlotId };
            }
            if (oldCandidate.discoverySlotId !== candidate.discoverySlotId) {
                changes.discoverySlotId = { from: oldCandidate.discoverySlotId, to: candidate.discoverySlotId };
            }
            if (oldCandidate.trainingSlotId !== candidate.trainingSlotId) {
                changes.trainingSlotId = { from: oldCandidate.trainingSlotId, to: candidate.trainingSlotId };
            }
            if (Object.keys(changes).length > 0) {
                logger.info({ event: "candidate.updated", candidateId: id, name: candidate.fullName, changes }, "📋 Candidate updated");
                logBusinessEvent({
                    event: "candidate.transition.applied",
                    candidateId: id,
                    telegramId: candidate.user?.telegramId,
                    actorType: "system",
                    actorRole: "system",
                    stage: candidate.status,
                    result: "success",
                    module: "candidate-repository",
                    operation: "update",
                    safeContext: {
                        fromStatus: transition.oldState.status,
                        toStatus: transition.nextState.status,
                        fromStep: transition.oldState.currentStep,
                        toStep: transition.nextState.currentStep,
                        changedFields: transition.changedFields,
                    },
                });
            }
        }

        // If status changed, sync channel access in background
        if ((normalizedData as any).status !== undefined && candidate.user?.telegramId) {
            import("../services/access-service.js").then(({ accessService }) => {
                accessService.syncUserAccess(candidate.user.telegramId).catch(() => { });
            }).catch(() => { });
        }

        return candidate;
    }

    async reopenNoShowCandidate(id: string, tx?: Prisma.TransactionClient): Promise<CandidateWithRelations> {
        const client = tx || prisma;
        const oldCandidate = await this.findById(id, tx);

        if (!oldCandidate) {
            throw new Error(`Candidate ${id} not found`);
        }

        if (oldCandidate.status !== CandidateStatus.REJECTED || oldCandidate.hrDecision !== "NOSHOW") {
            throw new Error("CANDIDATE_NOT_NOSHOW_REJECTED");
        }

        const candidate = await client.candidate.update({
            where: { id },
            data: {
                status: CandidateStatus.WAITLIST_HR,
                hrDecision: null,
                notificationSent: false,
                currentStep: FunnelStep.INTERVIEW,
                isWaitlisted: true,
                statusChangedAt: new Date(),
            },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true }
        }) as unknown as CandidateWithRelations;

        logger.info({
            event: "candidate.reopened_from_noshow",
            candidateId: id,
            name: candidate.fullName,
            changes: {
                status: { from: oldCandidate.status, to: candidate.status },
                hrDecision: { from: oldCandidate.hrDecision, to: candidate.hrDecision },
            }
        }, "📋 Candidate reopened from no-show");

        logBusinessEvent({
            event: "candidate.transition.reopened_noshow",
            candidateId: id,
            telegramId: candidate.user?.telegramId,
            actorType: "system",
            actorRole: "system",
            stage: candidate.status,
            result: "success",
            module: "candidate-repository",
            operation: "reopenNoShowCandidate",
            safeContext: {
                fromStatus: oldCandidate.status,
                toStatus: candidate.status,
                fromStep: oldCandidate.currentStep,
                toStep: candidate.currentStep,
                previousDecision: oldCandidate.hrDecision,
            },
        });

        logAuditEvent({
            event: "candidate.reopened_from_noshow",
            candidateId: id,
            telegramId: candidate.user?.telegramId,
            actorType: "system",
            actorRole: "system",
            stage: candidate.status,
            result: "success",
            module: "candidate-repository",
            operation: "reopenNoShowCandidate",
            safeContext: {
                fromStatus: oldCandidate.status,
                toStatus: candidate.status,
                fromStep: oldCandidate.currentStep,
                toStep: candidate.currentStep,
                previousDecision: oldCandidate.hrDecision,
            },
        });

        if (candidate.user?.telegramId) {
            import("../services/access-service.js").then(({ accessService }) => {
                accessService.syncUserAccess(candidate.user.telegramId).catch(() => { });
            }).catch(() => { });
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
        const runQuery = (resolvedStatus: CandidateStatus | CandidateStatus[]) => {
            return prisma.candidate.findMany({
                where: {
                    status: Array.isArray(resolvedStatus) ? { in: resolvedStatus } : resolvedStatus,
                    ...whereExtra
                },
                include: { user: true, location: true, firstShiftPartner: { include: { user: true } }, discoverySlot: true, trainingSlot: true, interviewSlot: true, messages: true },
                orderBy: { user: { createdAt: 'desc' } }
            }) as unknown as Promise<CandidateWithRelations[]>;
        };

        try {
            return await runQuery(status);
        } catch (error) {
            if (!Array.isArray(status) || !isUnknownCandidateStatusError(error)) {
                throw error;
            }

            const fallbackStatuses = status.filter(candidateStatus =>
                LEGACY_READABLE_CANDIDATE_STATUSES.includes(candidateStatus)
            );

            if (fallbackStatuses.length === 0) {
                throw error;
            }

            logger.warn(
                { err: error, requestedStatuses: status, fallbackStatuses },
                "Falling back to legacy-safe candidate statuses"
            );

            return await runQuery(fallbackStatuses);
        }
    }

    async updateMany(where: Prisma.CandidateWhereInput, data: Prisma.CandidateUpdateManyMutationInput) {
        let normalizedData = this.touchPipeline(data);
        const touchesFunnelFields = data.status !== undefined ||
            data.currentStep !== undefined ||
            data.materialsSent !== undefined ||
            data.hrDecision !== undefined ||
            data.interviewCompletedAt !== undefined;

        if (touchesFunnelFields) {
            const candidates = await prisma.candidate.findMany({
                where,
                select: {
                    id: true,
                    fullName: true,
                    status: true,
                    currentStep: true,
                    hrDecision: true,
                    isWaitlisted: true,
                    notificationSent: true,
                    materialsSent: true,
                    interviewCompletedAt: true,
                    interviewSlotId: true,
                    discoverySlotId: true,
                    trainingSlotId: true,
                }
            }) as unknown as CandidateFunnelSnapshot[];

            for (const candidate of candidates) {
                try {
                    const validation = this.validateFunnelPatch(candidate, normalizedData);
                    normalizedData = this.touchPipeline(validation.normalizedData as Prisma.CandidateUpdateManyMutationInput);
                } catch (error) {
                    if (error instanceof InvalidCandidateTransitionError) {
                        logBusinessEvent({
                            event: "candidate.transition.blocked",
                            level: "warn",
                            candidateId: candidate.id,
                            actorType: "system",
                            actorRole: "system",
                            stage: candidate.status,
                            result: "blocked",
                            reasonCode: error.reasonCode,
                            module: "candidate-repository",
                            operation: "updateMany",
                            safeContext: {
                                fromStatus: error.context.oldState.status,
                                toStatus: error.context.nextState.status,
                                changedFields: error.context.changedFields,
                            },
                            error,
                        });
                    }
                    throw error;
                }
            }
        }

        if ((normalizedData as any).status !== undefined) {
            (normalizedData as any).statusChangedAt = new Date();
        }
        const result = await prisma.candidate.updateMany({
            where,
            data: normalizedData
        });
        if ((normalizedData as any).status !== undefined && result.count > 0) {
            logger.info({ count: result.count, newStatus: (normalizedData as any).status, where: JSON.stringify(where).slice(0, 200) }, "📋 Candidate updateMany");
            logBusinessEvent({
                event: "candidate.transition.bulk_applied",
                candidateId: undefined,
                actorType: "system",
                actorRole: "system",
                stage: String((normalizedData as any).status),
                result: "success",
                module: "candidate-repository",
                operation: "updateMany",
                safeContext: {
                    count: result.count,
                    where: JSON.stringify(where).slice(0, 500),
                    status: String((normalizedData as any).status),
                },
            });
        }
        return result;
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
        const createData = this.touchPipeline(args.create as Prisma.CandidateUpdateInput) as typeof args.create;
        const updateData = this.touchPipeline(args.update as Prisma.CandidateUpdateInput) as typeof args.update;
        return prisma.candidate.upsert({
            ...args,
            create: createData,
            update: updateData,
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
            'SCREENING', 'WAITLIST', 'WAITLIST_HR', 'WAITLIST_MENTOR', 'MANUAL_REVIEW', 'INTERVIEW_SCHEDULED',
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
