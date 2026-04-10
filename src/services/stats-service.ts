import { CandidateStatus, FunnelStep } from "@prisma/client";

import prisma from "../db/core.js";
import { normalizeCity } from "../handlers/admin/utils.js";

const MIN_CANDIDATE_AGE = 17;
const MAX_CANDIDATE_AGE = 26;

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

type InvalidReasonKey = "bot" | "male" | "age" | "noDemand" | "incomplete";

type DashboardCandidate = {
    fullName: string | null;
    status: CandidateStatus;
    currentStep: FunnelStep;
    isWaitlisted: boolean;
    isOtherCity: boolean;
    gender: string | null;
    birthDate: Date | null;
    hrDecision: string | null;
    candidateDecision: string | null;
    lossStage: string | null;
    lossReason: string | null;
    lostAt: Date | null;
    statusChangedAt: Date | null;
    pipelineTouchedAt: Date;
    locationId: string | null;
    user: {
        createdAt: Date;
        botBlockedAt: Date | null;
    };
};

type DashboardLocation = {
    id: string;
    name: string;
    city: string;
    neededCount: number;
    isHidden: boolean;
};

type DashboardData = {
    rawTotal: number;
    rawWeek: number;
    validTotal: number;
    validWeek: number;
    invalidTotal: number;
    invalidWeek: number;
    invalidByReason: Record<InvalidReasonKey, number>;
    activeValidPool: number;
    reserveValidPool: number;
    hiresWeek: number;
    losses: {
        screening: number;
        interview: number;
        mentorIntro: number;
        training: number;
        finalPrep: number;
        onboarding: number;
    };
    funnel: {
        validBase: number;
        interviewTrack: number;
        hrApproved: number;
        mentorTrack: number;
        trainingTrack: number;
        finalPrep: number;
        hired: number;
    };
    health: PipelineHealthReport;
    locations: Array<{
        id: string;
        name: string;
        city: string;
        needed: number;
        active: number;
        reserve: number;
        hiredWeek: number;
        gap: number;
    }>;
    actions: string[];
};

type LossDrilldownReport = {
    byStage: Array<{ stage: string; count: number; share: number }>;
    byLocation: Array<{ city: string; location: string; count: number; share: number }>;
    byReason: Array<{ reason: string; count: number; share: number }>;
};

const RESERVE_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.WAITLIST,
    CandidateStatus.WAITLIST_HR,
    CandidateStatus.WAITLIST_MENTOR,
]);

const ACTIVE_VALID_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.SCREENING,
    CandidateStatus.MANUAL_REVIEW,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
    CandidateStatus.ACCEPTED,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.BLOCKER,
]);

const INTERVIEW_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
    CandidateStatus.ACCEPTED,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER,
]);

const HR_APPROVED_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.ACCEPTED,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER,
]);

const MENTOR_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER,
]);

const TRAINING_TRACK_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER,
]);

const FINAL_PREP_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
    CandidateStatus.HIRED,
    CandidateStatus.BLOCKER,
]);

function getCandidateAge(date: Date | null): number | null {
    if (!date) return null;
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const monthDelta = today.getMonth() - date.getMonth();
    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate())) {
        age--;
    }
    return age;
}

function pct(value: number, total: number): number {
    if (total <= 0) return 0;
    return Math.round((value / total) * 100);
}

function hasReachedInterview(candidate: DashboardCandidate): boolean {
    return candidate.currentStep === FunnelStep.INTERVIEW ||
        candidate.currentStep === FunnelStep.TRAINING ||
        candidate.currentStep === FunnelStep.FIRST_SHIFT ||
        INTERVIEW_TRACK_STATUSES.has(candidate.status);
}

function isBotBlocked(candidate: DashboardCandidate): boolean {
    return Boolean(candidate.user.botBlockedAt) ||
        candidate.candidateDecision?.includes("Бот заблоковано") === true;
}

function isAgeMismatch(candidate: DashboardCandidate): boolean {
    if (candidate.hrDecision === "REJECTED_SYSTEM_UNDERAGE" || candidate.hrDecision === "AGE_LIMIT") {
        return true;
    }
    const age = getCandidateAge(candidate.birthDate);
    if (age === null) return false;
    return age < MIN_CANDIDATE_AGE || age > MAX_CANDIDATE_AGE;
}

function isNoDemandCandidate(candidate: DashboardCandidate): boolean {
    return candidate.isOtherCity ||
        (candidate.isWaitlisted &&
            candidate.currentStep === FunnelStep.INITIAL_TEST &&
            (candidate.status === CandidateStatus.WAITLIST || candidate.status === CandidateStatus.WAITLIST_HR));
}

function getInvalidReason(candidate: DashboardCandidate): InvalidReasonKey | null {
    if (isBotBlocked(candidate)) return "bot";
    if (!candidate.gender || !candidate.birthDate || !candidate.locationId) return "incomplete";
    if (candidate.gender === "male") return "male";
    if (isAgeMismatch(candidate)) return "age";
    if (isNoDemandCandidate(candidate)) return "noDemand";
    return null;
}

function isBusinessValid(candidate: DashboardCandidate): boolean {
    return getInvalidReason(candidate) === null;
}

function isReserveCandidate(candidate: DashboardCandidate): boolean {
    return candidate.isWaitlisted && RESERVE_STATUSES.has(candidate.status);
}

function isActiveValidCandidate(candidate: DashboardCandidate): boolean {
    return isBusinessValid(candidate) &&
        ACTIVE_VALID_STATUSES.has(candidate.status) &&
        !candidate.isWaitlisted &&
        !isReserveCandidate(candidate);
}

function formatRateLine(label: string, count: number, base: number): string {
    return `• ${label}: <b>${count}</b> (${pct(count, base)}%)`;
}

function buildScope(city?: string, locationId?: string) {
    if (locationId) return { locationId };
    if (city) return { city };
    return {};
}

export const statsService = {
    async getOfficialCities(): Promise<string[]> {
        const locations = await prisma.location.findMany({
            where: { isHidden: false },
            select: { city: true },
            distinct: ["city"],
            orderBy: { city: "asc" }
        });
        return locations.map((location) => location.city);
    },

    async getLocationsForCity(city: string) {
        return prisma.location.findMany({
            where: { city, isHidden: false },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        });
    },

    async getWeeklyNewCount(city?: string, locationId?: string): Promise<number> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return prisma.candidate.count({
            where: {
                ...buildScope(city, locationId),
                user: { createdAt: { gte: weekAgo } }
            }
        });
    },

    async getCandidateFunnelStats(city?: string, locationId?: string): Promise<Record<string, number>> {
        const where = buildScope(city, locationId);
        const statuses = [
            CandidateStatus.SCREENING,
            CandidateStatus.WAITLIST,
            CandidateStatus.WAITLIST_HR,
            CandidateStatus.WAITLIST_MENTOR,
            CandidateStatus.MANUAL_REVIEW,
            CandidateStatus.INTERVIEW_SCHEDULED,
            CandidateStatus.INTERVIEW_COMPLETED,
            CandidateStatus.DECISION_PENDING,
            CandidateStatus.ACCEPTED,
            CandidateStatus.DISCOVERY_SCHEDULED,
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
            CandidateStatus.NDA,
            CandidateStatus.KNOWLEDGE_TEST,
            CandidateStatus.STAGING_SETUP,
            CandidateStatus.STAGING_ACTIVE,
            CandidateStatus.OFFLINE_STAGING,
            CandidateStatus.READY_FOR_HIRE,
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
            CandidateStatus.REJECTED,
            CandidateStatus.BLOCKER,
        ];

        const counts: Record<string, number> = {};
        for (const status of statuses) {
            counts[status] = await prisma.candidate.count({ where: { ...where, status } });
        }
        counts.TOTAL = await prisma.candidate.count({ where });
        return counts;
    },

    async getPipelineHealthReport(city?: string, locationId?: string): Promise<PipelineHealthReport> {
        const scope = buildScope(city, locationId);
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
                    status: CandidateStatus.SCREENING,
                    currentStep: FunnelStep.INTERVIEW,
                    interviewSlotId: null,
                    interviewInvitedAt: { lte: screeningCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: CandidateStatus.WAITLIST_HR,
                    pipelineTouchedAt: { lte: waitlistCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: CandidateStatus.ACCEPTED,
                    materialsSent: true,
                    discoverySlotId: null,
                    trainingSlotId: null,
                    pipelineTouchedAt: { lte: acceptedCutoff }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: CandidateStatus.DISCOVERY_SCHEDULED,
                    discoverySlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: CandidateStatus.TRAINING_SCHEDULED,
                    trainingSlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: CandidateStatus.BLOCKER
                }
            }),
            prisma.candidate.count({
                where: {
                    ...scope,
                    status: {
                        in: [
                            CandidateStatus.NDA,
                            CandidateStatus.KNOWLEDGE_TEST,
                            CandidateStatus.STAGING_SETUP,
                            CandidateStatus.STAGING_ACTIVE,
                            CandidateStatus.READY_FOR_HIRE,
                            CandidateStatus.AWAITING_FIRST_SHIFT,
                        ]
                    },
                    pipelineTouchedAt: { lte: finalStepCutoff }
                }
            }),
            prisma.candidate.findMany({
                where: {
                    ...scope,
                    OR: [
                        {
                            status: CandidateStatus.ACCEPTED,
                            materialsSent: true,
                            discoverySlotId: null,
                            trainingSlotId: null,
                            pipelineTouchedAt: { lte: acceptedCutoff }
                        },
                        {
                            status: CandidateStatus.TRAINING_SCHEDULED,
                            trainingSlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                        },
                        {
                            status: CandidateStatus.DISCOVERY_SCHEDULED,
                            discoverySlot: { is: { startTime: { lt: mentorOutcomeCutoff } } }
                        },
                        {
                            status: CandidateStatus.BLOCKER
                        }
                    ]
                },
                select: { fullName: true, status: true },
                take: 5,
                orderBy: { pipelineTouchedAt: "asc" }
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
            examples: exampleCandidates.map((candidate) => `${candidate.fullName || "Candidate"} (${candidate.status})`)
        };
    },

    async getManagementDashboardData(city?: string, locationId?: string): Promise<DashboardData> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const scope = buildScope(city, locationId);

        const [candidates, locations, health] = await Promise.all([
            prisma.candidate.findMany({
                where: scope,
                select: {
                    fullName: true,
                    status: true,
                    currentStep: true,
                    isWaitlisted: true,
                    isOtherCity: true,
                    gender: true,
                    birthDate: true,
                    hrDecision: true,
                    candidateDecision: true,
                    lossStage: true,
                    lossReason: true,
                    lostAt: true,
                    statusChangedAt: true,
                    pipelineTouchedAt: true,
                    locationId: true,
                    user: {
                        select: {
                            createdAt: true,
                            botBlockedAt: true,
                        }
                    }
                }
            }) as Promise<DashboardCandidate[]>,
            prisma.location.findMany({
                where: {
                    ...(locationId ? { id: locationId } : city ? { city } : {}),
                    isHidden: false,
                },
                select: {
                    id: true,
                    name: true,
                    city: true,
                    neededCount: true,
                    isHidden: true,
                }
            }) as Promise<DashboardLocation[]>,
            this.getPipelineHealthReport(city, locationId)
        ]);

        const invalidByReason: Record<InvalidReasonKey, number> = {
            bot: 0,
            male: 0,
            age: 0,
            noDemand: 0,
            incomplete: 0,
        };

        let rawWeek = 0;
        let validWeek = 0;
        let hiresWeek = 0;
        const losses = {
            screening: 0,
            interview: 0,
            mentorIntro: 0,
            training: 0,
            finalPrep: 0,
            onboarding: 0,
        };
        let validTotal = 0;
        let activeValidPool = 0;
        let reserveValidPool = 0;
        let interviewTrack = 0;
        let hrApproved = 0;
        let mentorTrack = 0;
        let trainingTrack = 0;
        let finalPrep = 0;
        let hired = 0;

        const locationMap = new Map<string, DashboardData["locations"][number]>();
        for (const location of locations) {
            locationMap.set(location.id, {
                id: location.id,
                name: location.name,
                city: location.city,
                needed: location.neededCount,
                active: 0,
                reserve: 0,
                hiredWeek: 0,
                gap: location.neededCount,
            });
        }

        for (const candidate of candidates) {
            const createdThisWeek = candidate.user.createdAt >= weekAgo;
            const invalidReason = getInvalidReason(candidate);
            const isValid = invalidReason === null;
            const isReserve = isReserveCandidate(candidate);
            const locationStats = candidate.locationId ? locationMap.get(candidate.locationId) : null;

            if (createdThisWeek) rawWeek++;
            if (invalidReason) {
                invalidByReason[invalidReason]++;
            } else {
                validTotal++;
                if (createdThisWeek) validWeek++;

                if (isActiveValidCandidate(candidate)) {
                    activeValidPool++;
                    if (locationStats) locationStats.active++;
                }

                if (isReserve) {
                    reserveValidPool++;
                    if (locationStats) locationStats.reserve++;
                }

                if (hasReachedInterview(candidate)) {
                    interviewTrack++;
                }

                if (candidate.hrDecision === "ACCEPTED" || HR_APPROVED_STATUSES.has(candidate.status)) {
                    hrApproved++;
                }

                if (MENTOR_TRACK_STATUSES.has(candidate.status)) {
                    mentorTrack++;
                }

                if (TRAINING_TRACK_STATUSES.has(candidate.status)) {
                    trainingTrack++;
                }

                if (FINAL_PREP_STATUSES.has(candidate.status)) {
                    finalPrep++;
                }
            }

            if (candidate.status === CandidateStatus.REJECTED && candidate.lossStage) {
                switch (candidate.lossStage) {
                    case "SCREENING":
                    case "INTERVIEW_BOOKING":
                        losses.screening++;
                        break;
                    case "INTERVIEW":
                        losses.interview++;
                        break;
                    case "MENTOR_INTRO":
                        losses.mentorIntro++;
                        break;
                    case "TRAINING":
                        losses.training++;
                        break;
                    case "FINAL_PREP":
                        losses.finalPrep++;
                        break;
                    case "ONBOARDING":
                        losses.onboarding++;
                        break;
                    default:
                        break;
                }
            }

            if (candidate.status === CandidateStatus.HIRED) {
                hired++;
                if (candidate.statusChangedAt && candidate.statusChangedAt >= weekAgo) {
                    hiresWeek++;
                    if (locationStats) locationStats.hiredWeek++;
                }
            }

            if (locationStats) {
                locationStats.gap = locationStats.needed - locationStats.active;
            }

            if (!isValid && createdThisWeek && invalidReason) {
                // Weekly invalid total is derived later from rawWeek - validWeek.
            }
        }

        const prioritizedLocations = Array.from(locationMap.values())
            .sort((left, right) => {
                if (left.gap !== right.gap) return right.gap - left.gap;
                if (left.reserve !== right.reserve) return right.reserve - left.reserve;
                return left.city.localeCompare(right.city);
            });

        const rawTotal = candidates.length;
        const invalidTotal = rawTotal - validTotal;
        const invalidWeek = rawWeek - validWeek;

        const actions: string[] = [];
        const invalidRate = rawWeek > 0 ? validWeek / rawWeek : rawTotal > 0 ? validTotal / rawTotal : 1;
        const topDeficitLocations = prioritizedLocations.filter((location) => location.gap > 0).slice(0, 2);

        if (1 - invalidRate >= 0.45) {
            actions.push("Перевірити джерела трафіку та pre-screening: занадто високий відсів до валідної бази.");
        }
        if (health.staleScreening > 5) {
            actions.push("Розвантажити screening чергу: є кандидати без руху понад 48 годин.");
        }
        if (health.stalledAccepted + health.overdueDiscovery + health.overdueTraining > 3) {
            actions.push("Підсилити handoff у mentor track: accepted/discovery/training зависають довше SLA.");
        }
        if (topDeficitLocations.length > 0) {
            actions.push(`Закрити дефіцит по локаціях: ${topDeficitLocations.map((location) => `${normalizeCity(location.city)} / ${location.name}`).join(", ")}.`);
        }
        if (reserveValidPool > activeValidPool && reserveValidPool >= 10) {
            actions.push("Переглянути логіку waitlist: резерв уже більший за активний робочий пул.");
        }
        if (actions.length === 0) {
            actions.push("Критичних відхилень не виявлено. Сфокусуйтесь на підтриманні швидкості обробки та локаційного балансу.");
        }

        return {
            rawTotal,
            rawWeek,
            validTotal,
            validWeek,
            invalidTotal,
            invalidWeek,
            invalidByReason,
            activeValidPool,
            reserveValidPool,
            hiresWeek,
            losses,
            funnel: {
                validBase: validTotal,
                interviewTrack,
                hrApproved,
                mentorTrack,
                trainingTrack,
                finalPrep,
                hired,
            },
            health,
            locations: prioritizedLocations,
            actions,
        };
    },

    formatManagementDashboard(data: DashboardData, city?: string, locationName?: string): string {
        let locationLabel = "🌍 <b>All Cities</b>";
        if (locationName) {
            locationLabel = `📍 City: <b>${city ? normalizeCity(city) : city}</b>\n🏠 Location: <b>${locationName}</b>`;
        } else if (city) {
            locationLabel = `📍 City: <b>${normalizeCity(city)}</b>`;
        }

        const invalidRateWeek = pct(data.invalidWeek, data.rawWeek);
        const validRateWeek = pct(data.validWeek, data.rawWeek);

        const alertLines = [
            data.health.staleScreening > 0 ? `• Screening stale >48h: <b>${data.health.staleScreening}</b>` : null,
            data.health.stalledAccepted > 0 ? `• Accepted без booking: <b>${data.health.stalledAccepted}</b>` : null,
            (data.health.overdueDiscovery + data.health.overdueTraining) > 0
                ? `• Mentor / training overdue: <b>${data.health.overdueDiscovery + data.health.overdueTraining}</b>`
                : null,
            data.health.blockers > 0 ? `• Blockers у флоу: <b>${data.health.blockers}</b>` : null,
            data.health.staleFinalStep > 0 ? `• Final step stale: <b>${data.health.staleFinalStep}</b>` : null,
        ].filter(Boolean);

        const locationLines = data.locations
            .filter((location) => location.needed > 0 || location.reserve > 0 || location.active > 0)
            .slice(0, locationName ? 1 : 4)
            .map((location) => {
                const status = location.gap > 0 ? "🔴 Deficit" : location.needed === 0 && location.reserve > 0 ? "⏸️ Reserve" : "🟢 OK";
                return `• ${normalizeCity(location.city)} / ${location.name}: need <b>${location.needed}</b> | active <b>${location.active}</b> | reserve <b>${location.reserve}</b> | hires 7d <b>${location.hiredWeek}</b> | ${status}`;
            });

        const actionLines = data.actions.slice(0, 4).map((action) => `• ${action}`);
        const lossLines = [
            `• Screening: <b>${data.losses.screening}</b>`,
            `• Interview: <b>${data.losses.interview}</b>`,
            `• Mentor intro: <b>${data.losses.mentorIntro}</b>`,
            `• Training: <b>${data.losses.training}</b>`,
            `• Final prep: <b>${data.losses.finalPrep}</b>`,
            `• Onboarding: <b>${data.losses.onboarding}</b>`,
        ];

        return `<b>📊 HR Recruitment Dashboard</b>\n${locationLabel}\n` +
            `───────────────────\n\n` +
            `<b>KPI</b>\n` +
            `📥 Raw 7d: <b>${data.rawWeek}</b> (base: ${data.rawTotal})\n` +
            `✅ Valid 7d: <b>${data.validWeek}</b> (${validRateWeek}%)\n` +
            `🧹 Invalid 7d: <b>${data.invalidWeek}</b> (${invalidRateWeek}%)\n` +
            `🗂️ Active valid pool: <b>${data.activeValidPool}</b>\n` +
            `📦 Reserve / waitlist: <b>${data.reserveValidPool}</b>\n` +
            `💼 Hires 7d: <b>${data.hiresWeek}</b>\n\n` +
            `<b>Validity</b>\n` +
            `• Valid base now: <b>${data.validTotal}</b>\n` +
            `• Invalid base now: <b>${data.invalidTotal}</b>\n` +
            `• Bots / blocked: <b>${data.invalidByReason.bot}</b>\n` +
            `• Male applicants: <b>${data.invalidByReason.male}</b>\n` +
            `• Age mismatch: <b>${data.invalidByReason.age}</b>\n` +
            `• No-demand / other city: <b>${data.invalidByReason.noDemand}</b>\n` +
            `• Incomplete screening: <b>${data.invalidByReason.incomplete}</b>\n\n` +
            `<b>Funnel</b>\n` +
            `• Valid base: <b>${data.funnel.validBase}</b>\n` +
            `${formatRateLine("Interview track", data.funnel.interviewTrack, data.funnel.validBase)}\n` +
            `${formatRateLine("HR approved", data.funnel.hrApproved, data.funnel.interviewTrack)}\n` +
            `${formatRateLine("Mentor intro", data.funnel.mentorTrack, data.funnel.hrApproved)}\n` +
            `${formatRateLine("Training", data.funnel.trainingTrack, data.funnel.mentorTrack)}\n` +
            `${formatRateLine("Final prep", data.funnel.finalPrep, data.funnel.trainingTrack)}\n` +
            `${formatRateLine("Hired", data.funnel.hired, data.funnel.finalPrep)}\n\n` +
            `<b>Losses By Stage</b>\n` +
            `${lossLines.join("\n")}\n\n` +
            `<b>Alerts</b>\n` +
            `${alertLines.length > 0 ? alertLines.join("\n") : "• Критичних SLA-відхилень зараз немає"}\n\n` +
            `<b>Locations</b>\n` +
            `${locationLines.length > 0 ? locationLines.join("\n") : "• Немає активних локацій у вибраному зрізі"}\n\n` +
            `<b>Recommended Actions</b>\n` +
            `${actionLines.join("\n")}`;
    },

    async buildManagementDashboard(city?: string, locationId?: string, locationName?: string): Promise<string> {
        const data = await this.getManagementDashboardData(city, locationId);
        return this.formatManagementDashboard(data, city, locationName);
    },

    async getLossDrilldownReport(city?: string, locationId?: string): Promise<LossDrilldownReport> {
        const scope = buildScope(city, locationId);
        const rejected = await prisma.candidate.findMany({
            where: {
                ...scope,
                status: CandidateStatus.REJECTED,
            },
            select: {
                lossStage: true,
                lossReason: true,
                city: true,
                location: {
                    select: {
                        name: true,
                    }
                }
            }
        });

        const byStage = new Map<string, number>();
        const byReason = new Map<string, number>();
        const byLocation = new Map<string, { city: string; location: string; count: number }>();

        for (const candidate of rejected) {
            const stage = candidate.lossStage || "UNKNOWN";
            const reason = candidate.lossReason || "UNKNOWN";
            const locationName = candidate.location?.name || "Unknown location";
            const cityName = candidate.city || "Unknown city";

            byStage.set(stage, (byStage.get(stage) || 0) + 1);
            byReason.set(reason, (byReason.get(reason) || 0) + 1);

            const locationKey = `${cityName}::${locationName}`;
            const locationEntry = byLocation.get(locationKey) || { city: cityName, location: locationName, count: 0 };
            locationEntry.count++;
            byLocation.set(locationKey, locationEntry);
        }

        const total = rejected.length || 1;
        return {
            byStage: Array.from(byStage.entries())
                .map(([stage, count]) => ({ stage, count, share: pct(count, total) }))
                .sort((a, b) => b.count - a.count),
            byLocation: Array.from(byLocation.values())
                .map((entry) => ({ ...entry, share: pct(entry.count, total) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
            byReason: Array.from(byReason.entries())
                .map(([reason, count]) => ({ reason, count, share: pct(count, total) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
        };
    },

    async buildLossDrilldown(city?: string, locationId?: string, locationName?: string): Promise<string> {
        const report = await this.getLossDrilldownReport(city, locationId);
        let locationLabel = "🌍 <b>All Cities</b>";
        if (locationName) {
            locationLabel = `📍 City: <b>${city ? normalizeCity(city) : city}</b>\n🏠 Location: <b>${locationName}</b>`;
        } else if (city) {
            locationLabel = `📍 City: <b>${normalizeCity(city)}</b>`;
        }

        const stageLines = report.byStage.length > 0
            ? report.byStage.map((item) => `• ${item.stage}: <b>${item.count}</b> (${item.share}%)`).join("\n")
            : "• No rejected candidates";
        const reasonLines = report.byReason.length > 0
            ? report.byReason.map((item) => `• ${item.reason}: <b>${item.count}</b> (${item.share}%)`).join("\n")
            : "• No rejected candidates";
        const locationLines = report.byLocation.length > 0
            ? report.byLocation.map((item) => `• ${normalizeCity(item.city)} / ${item.location}: <b>${item.count}</b> (${item.share}%)`).join("\n")
            : "• No rejected candidates";

        return `<b>🔎 Loss Drilldown</b>\n${locationLabel}\n` +
            `───────────────────\n\n` +
            `<b>Losses By Stage</b>\n${stageLines}\n\n` +
            `<b>Top Loss Reasons</b>\n${reasonLines}\n\n` +
            `<b>Losses By Location</b>\n${locationLines}`;
    },

    formatFunnelDashboard(stats: Record<string, number>, weeklyNew: number, city?: string, locationName?: string, health?: PipelineHealthReport): string {
        const mentorTrack = (stats[CandidateStatus.DISCOVERY_SCHEDULED] ?? 0) + (stats[CandidateStatus.DISCOVERY_COMPLETED] ?? 0);
        const trainingTrack = (stats[CandidateStatus.TRAINING_SCHEDULED] ?? 0) + (stats[CandidateStatus.TRAINING_COMPLETED] ?? 0);
        const finalPrep = (stats[CandidateStatus.NDA] ?? 0) +
            (stats[CandidateStatus.KNOWLEDGE_TEST] ?? 0) +
            (stats[CandidateStatus.STAGING_SETUP] ?? 0) +
            (stats[CandidateStatus.STAGING_ACTIVE] ?? 0) +
            (stats[CandidateStatus.OFFLINE_STAGING] ?? 0) +
            (stats[CandidateStatus.READY_FOR_HIRE] ?? 0) +
            (stats[CandidateStatus.AWAITING_FIRST_SHIFT] ?? 0);

        let locationLabel = "🌍 <b>All Cities</b>";
        if (locationName) {
            locationLabel = `📍 City: <b>${city ? normalizeCity(city) : city}</b>\n🏠 Location: <b>${locationName}</b>`;
        } else if (city) {
            locationLabel = `📍 City: <b>${normalizeCity(city)}</b>`;
        }

        return `<b>📊 HR Funnel Dashboard</b>\n${locationLabel}\n` +
            `───────────────────\n\n` +
            `<b>Legacy Snapshot</b>\n` +
            `📥 Total Apps: <b>${stats.TOTAL ?? 0}</b>\n` +
            `📈 This week: <b>+${weeklyNew}</b>\n` +
            `👥 Interview track: <b>${stats[CandidateStatus.INTERVIEW_SCHEDULED] ?? 0}</b>\n` +
            `🎯 Mentor intro: <b>${mentorTrack}</b>\n` +
            `🎓 Training: <b>${trainingTrack}</b>\n` +
            `🚀 Final prep: <b>${finalPrep}</b>\n` +
            `💼 Hired: <b>${stats[CandidateStatus.HIRED] ?? 0}</b>` +
            (health && health.examples.length > 0
                ? `\n\n<b>Sample Risk Cases</b>\n${health.examples.map((example) => `• ${example}`).join("\n")}`
                : "");
    }
};
