import { candidateRepository } from "../repositories/candidate-repository.js";

import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

const t = (key: string, args?: any) => {
    // @ts-ignore
    const text = ADMIN_TEXTS[key] || STAFF_TEXTS[key];
    if (typeof text === 'function') return text(args || {});
    return text || key;
};


import prisma from "../db/core.js";

type PipelineHealthReport = {
    staleScreening: number;
    staleWaitlistHr: number;
    stalledAccepted: number;
    overdueDiscovery: number;
    overdueTraining: number;
    blockers: number;
    staleFinalStep: number;
    examples: string[];
};

export const statsService = {
    async getCandidateFunnelStats(city?: string, locationId?: string) {
        return candidateRepository.getFunnelStats(city, locationId);
    },

    async getWeeklyNewCount(city?: string, locationId?: string): Promise<number> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return candidateRepository.countCreatedAfter(weekAgo, city, locationId);
    },

    async getOfficialCities(): Promise<string[]> {
        const locations = await prisma.location.findMany({
            where: { isHidden: false },
            select: { city: true },
            distinct: ['city'],
            orderBy: { city: 'asc' }
        });
        return locations.map(l => l.city);
    },

    async getLocationsForCity(city: string) {
        return prisma.location.findMany({
            where: { city, isHidden: false },
            select: { id: true, name: true },
            orderBy: { name: 'asc' }
        });
    },

    async getPipelineHealthReport(city?: string, locationId?: string): Promise<PipelineHealthReport> {
        const scope: any = locationId ? { locationId } : city ? { city } : {};
        const now = new Date();
        const screeningCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
        const waitlistCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const acceptedCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        const mentorOutcomeCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        const finalStepCutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

        const [
            staleScreening,
            staleWaitlistHr,
            stalledAccepted,
            overdueDiscovery,
            overdueTraining,
            blockers,
            staleFinalStep,
            exampleCandidates,
        ] = await Promise.all([
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'SCREENING',
                    currentStep: 'INTERVIEW',
                    interviewSlotId: null,
                    interviewInvitedAt: { lte: screeningCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'WAITLIST_HR',
                    pipelineTouchedAt: { lte: waitlistCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'ACCEPTED',
                    materialsSent: true,
                    discoverySlotId: null,
                    trainingSlotId: null,
                    pipelineTouchedAt: { lte: acceptedCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'DISCOVERY_SCHEDULED',
                    discoverySlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'TRAINING_SCHEDULED',
                    trainingSlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: 'BLOCKER'
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: { in: ['NDA', 'KNOWLEDGE_TEST', 'STAGING_SETUP', 'STAGING_ACTIVE', 'READY_FOR_HIRE', 'AWAITING_FIRST_SHIFT'] as any },
                    pipelineTouchedAt: { lte: finalStepCutoff }
                }
            }),
            prisma.candidate.findMany({
                where: {
                    ...scope,
                    OR: [
                        {
                            status: 'ACCEPTED',
                            materialsSent: true,
                            discoverySlotId: null,
                            trainingSlotId: null,
                            pipelineTouchedAt: { lte: acceptedCutoff }
                        },
                        {
                            status: 'TRAINING_SCHEDULED',
                            trainingSlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                        },
                        {
                            status: 'DISCOVERY_SCHEDULED',
                            discoverySlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                        },
                        {
                            status: 'BLOCKER'
                        }
                    ]
                },
                select: { fullName: true, status: true },
                take: 5,
                orderBy: { pipelineTouchedAt: 'asc' }
            })
        ]);

        return {
            staleScreening,
            staleWaitlistHr,
            stalledAccepted,
            overdueDiscovery,
            overdueTraining,
            blockers,
            staleFinalStep,
            examples: exampleCandidates.map(c => `${c.fullName || 'Candidate'} (${c.status})`)
        };
    },

    formatFunnelDashboard(stats: Record<string, number>, weeklyNew: number, city?: string, locationName?: string, health?: PipelineHealthReport): string {
        const total = stats['TOTAL'] ?? 0;

        const screening = stats['SCREENING'] ?? 0;
        const waitlist = (stats['WAITLIST'] ?? 0) + (stats['WAITLIST_HR'] ?? 0) + (stats['WAITLIST_MENTOR'] ?? 0);
        const manualReview = stats['MANUAL_REVIEW'] ?? 0;
        const interviewScheduled = stats['INTERVIEW_SCHEDULED'] ?? 0;
        const interviewCompleted = stats['INTERVIEW_COMPLETED'] ?? 0;
        const decisionPending = stats['DECISION_PENDING'] ?? 0;
        const accepted = stats['ACCEPTED'] ?? 0;
        const trainingScheduled = stats['TRAINING_SCHEDULED'] ?? 0;
        const trainingCompleted = stats['TRAINING_COMPLETED'] ?? 0;
        const nda = stats['NDA'] ?? 0;
        const knowledgeTest = stats['KNOWLEDGE_TEST'] ?? 0;
        const stagingSetup = stats['STAGING_SETUP'] ?? 0;
        const stagingActive = stats['STAGING_ACTIVE'] ?? 0;
        const readyForHire = stats['READY_FOR_HIRE'] ?? 0;
        const offlineStaging = stats['OFFLINE_STAGING'] ?? 0;
        const awaitingFirstShift = stats['AWAITING_FIRST_SHIFT'] ?? 0;
        const hired = stats['HIRED'] ?? 0;
        const rejected = stats['REJECTED'] ?? 0;

        const onTraining = trainingScheduled + trainingCompleted + nda + knowledgeTest;
        const inStaging = stagingSetup + stagingActive + readyForHire + offlineStaging + awaitingFirstShift;

        // Conversion calculations
        const totalAccepted = accepted + onTraining + inStaging + hired;
        const totalInterviewed = interviewCompleted + decisionPending + totalAccepted;

        const appToHiredCR = total > 0 ? Math.round((hired / total) * 100) : 0;
        const intToAccCR = totalInterviewed > 0 ? Math.round((totalAccepted / totalInterviewed) * 100) : 0;
        const appToIntCR = total > 0 ? Math.round((totalInterviewed / total) * 100) : 0;

        let locationLabel = '🌍 <b>All Cities</b>';
        if (locationName) {
            locationLabel = `📍 City: <b>${city}</b>\n🏠 Location: <b>${locationName}</b>`;
        } else if (city) {
            locationLabel = `📍 City: <b>${city}</b>`;
        }

        return `<b>📊 HR Funnel Dashboard</b>\n${locationLabel}\n` +
            `───────────────────\n\n` +
            `<b>1. ACQUISITION</b>\n` +
            `📥 Total Apps: <b>${total}</b>\n` +
            `📈 This week: <b>+${weeklyNew}</b>\n\n` +
            `<b>2. CONVERSION</b>\n` +
            `👥 Interviews: <b>${totalInterviewed}</b> (${appToIntCR}% CR)\n` +
            `🎉 Accepted: <b>${totalAccepted}</b> (${intToAccCR}% CR)\n` +
            `💼 Hired: <b>${hired}</b> (${appToHiredCR}% Total CR)\n\n` +
            `<b>3. HEALTH CHECK</b>\n` +
            `⏳ Decision Pending: <b>${decisionPending}</b> ${decisionPending > 5 ? '⚠️' : ''}\n` +
            `📦 Waitlist: <b>${waitlist}</b>\n` +
            `💍 Manual Review: <b>${manualReview}</b>\n` +
            (health ? (
                `🚨 Stale Screening Invites: <b>${health.staleScreening}</b>\n` +
                `🕰️ Old Waitlist HR: <b>${health.staleWaitlistHr}</b>\n` +
                `🎓 Accepted No Booking: <b>${health.stalledAccepted}</b>\n` +
                `🏁 Overdue Mentor Results: <b>${health.overdueDiscovery + health.overdueTraining}</b>\n` +
                `🧱 Blockers: <b>${health.blockers}</b>\n` +
                `📋 Stale Final Step: <b>${health.staleFinalStep}</b>\n\n`
            ) : `\n`) +
            `<b>4. CURRENT FLOW</b>\n` +
            `📅 Scheduled: <b>${interviewScheduled}</b>\n` +
            `🎓 In Training: <b>${onTraining}</b>\n` +
            `📸 Staging: <b>${inStaging}</b>\n\n` +
            `❌ Rejected: ${rejected}` +
            (health && health.examples.length > 0
                ? `\n\n<b>Sample Risk Cases</b>\n${health.examples.map(example => `• ${example}`).join('\n')}`
                : '');
    }
};
