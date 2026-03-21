import { InlineKeyboard } from "grammy";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import prisma from "../db/core.js";
import { accessService } from "./access-service.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { MENTOR_IDS } from "../config.js";
import { getLocationDetails } from "../utils/location-data-helper.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import logger from "../core/logger.js";

export async function notifyMentors(api: any, candidate: any) {
    if (!MENTOR_IDS || MENTOR_IDS.length === 0) return;

    const msg = `📥 <b>New candidate is waiting for materials!</b>\n\n` +
        `👤 Name: <b>${candidate.fullName}</b>\n` +
        `🏙️ City: <b>${candidate.city}</b>\n` +
        `📍 Location: <b>${candidate.location?.name || '—'}</b>\n\n` +
        `Please go to <b>Mentor Hub</b> and send the knowledge base. ✨`;

    for (const id of MENTOR_IDS) {
        try {
            await api.sendMessage(id, msg, { parse_mode: "HTML" });
        } catch (e) { }
    }
}
function getPostInterviewSummaryText(candidate: any) {
    const firstName = extractFirstName(candidate.fullName || "");

    const loc = candidate.location;
    const staticInfo = getLocationDetails(loc?.name);

    const locationName = loc?.name || "Smile Park";
    const address = staticInfo?.address || loc?.address || "адреса вказана в Google Maps";
    const schedule = staticInfo?.schedule || loc?.schedule || "Пн-Пт 14:00-21:00, Сб-Нд 12:00-21:00";
    const salary = staticInfo?.salary || loc?.salary || "Комісія: 20% будні / 30% вихідні";

    return `<b>Приємно було познайомитися!</b> 😊\n\n` +
        `Твоя майбутня робота в деталях:\n\n` +
        `📍 <b>Локація</b>\n${locationName}\n${address}\n\n` +
        `📅 <b>Графік</b>\n${schedule}\n(2–3 зміни на тиждень)\n\n` +
        `💰 <b>Оплата</b>\n${salary}\n\n` +
        `Ми створюємо яскраві емоції та цінуємо розвиток кожного. PlayPhoto — це про людей. ✨\n\n` +
        `<b>Раді бачити тебе в нашій команді!</b> 🤍`;
}

export const hrService = {
    async getHubStats() {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [
            newCandidates,
            todayInterviews,
            waitingDecision,
            hiredWeek,
            tattooCount,
            unreadCount,
            waitlistCount,
            noSlotCount,
            finalStepStats
        ] = await Promise.all([
            candidateRepository.countByStatusAndSlot(CandidateStatus.SCREENING, null, { appearance: { not: null }, isOtherCity: false }),
            interviewRepository.countBookedInRange(startOfDay, endOfDay, {
                candidate: {
                    status: CandidateStatus.INTERVIEW_SCHEDULED,
                    hrDecision: null
                }
            }),
            candidateRepository.countByStatusAndSlot(CandidateStatus.INTERVIEW_COMPLETED, null, { hrDecision: null }),
            candidateRepository.countHiredAfter(weekAgo),
            candidateRepository.countByStatus(CandidateStatus.MANUAL_REVIEW),
            candidateRepository.countUnreadByScope("HR"),
            prisma.candidate.count({
                where: {
                    status: CandidateStatus.WAITLIST,
                    isWaitlisted: true,
                    currentStep: { in: [FunnelStep.INITIAL_TEST, FunnelStep.INTERVIEW] }
                }
            }),
            candidateRepository.countByStatusAndSlot(CandidateStatus.WAITLIST, null, { currentStep: FunnelStep.INTERVIEW }),
            this.getFinalStepStats()
        ]);

        const inboxTotal = tattooCount + unreadCount + (noSlotCount || 0) + finalStepStats.total;

        return {
            newCandidates,
            todayInterviews,
            hiredWeek,
            inboxTotal,
            tattooCount,
            unreadCount,
            waitlistCount,
            noSlotCount,
            waitingDecision,
            finalStepStats
        };
    },

    async getFinalStepStats() {
        const [ndaPending, testPending, stagingSetup, activeStaging, fillingData, readyForSchedule] = await Promise.all([
            prisma.candidate.count({ where: { status: CandidateStatus.NDA } }),
            prisma.candidate.count({ where: { status: CandidateStatus.KNOWLEDGE_TEST } }),
            prisma.candidate.count({ where: { status: CandidateStatus.STAGING_SETUP } }),
            prisma.candidate.count({ where: { status: CandidateStatus.STAGING_ACTIVE } }),
            prisma.candidate.count({ where: { status: CandidateStatus.READY_FOR_HIRE } }),
            prisma.candidate.count({ where: { status: CandidateStatus.AWAITING_FIRST_SHIFT } })
        ]);

        return {
            total: ndaPending + testPending + stagingSetup + activeStaging + fillingData + readyForSchedule,
            ndaPending,
            testPending,
            stagingSetup,
            activeStaging,
            fillingData,
            readyForSchedule
        };
    },

    async getNDAPendingCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.NDA },
            include: { user: true, location: true },
            orderBy: { ndaSentAt: 'asc' }
        });
    },

    async getTestPendingCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.KNOWLEDGE_TEST },
            include: { user: true, location: true },
            orderBy: { ndaConfirmedAt: 'asc' }
        });
    },

    async getStagingSetupCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.STAGING_SETUP },
            include: { user: true, location: true },
            orderBy: { user: { updatedAt: 'asc' } }
        });
    },

    async getActiveStagingCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.STAGING_ACTIVE },
            include: { user: true, location: true, firstShiftPartner: true },
            orderBy: { firstShiftDate: 'asc' }
        });
    },

    async getFillingDataCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.READY_FOR_HIRE },
            include: { user: true, location: true },
            orderBy: { statusChangedAt: 'asc' }
        });
    },

    async getReadyForScheduleCandidates() {
        return prisma.candidate.findMany({
            where: { status: CandidateStatus.AWAITING_FIRST_SHIFT },
            include: { user: true, location: true },
            orderBy: { statusChangedAt: 'asc' }
        });
    },

    async pingNDA(api: any, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return;
        const { NDA_LINK } = await import("../config.js");
        const firstName = extractFirstName(cand.fullName || "");
        const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", `confirm_nda_${cand.id}`);
        await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["nda-reminder"](firstName, NDA_LINK), { parse_mode: "HTML", reply_markup: kb });
    },

    async pingTest(api: any, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return;
        const kb = new InlineKeyboard().text("📝 Почати тест", `start_training_test_${cand.id}`);
        await api.sendMessage(Number(cand.user.telegramId), `<b>Продовжимо твій шлях? ✨</b>\n\nТи вже ознайомилась з NDA. Залишився останній крок перед виходом на локацію — короткий тест. Давай перевіримо твої знання! 📸`, { parse_mode: "HTML", reply_markup: kb });
    },

    async getHubText(stats?: any) {
        if (!stats) stats = await this.getHubStats();

        let urgentText = "";
        if (stats.unreadCount > 0 || stats.tattooCount > 0 || stats.noSlotCount > 0) {
            urgentText = `🔴 <b>Urgent:</b>\n` +
                (stats.unreadCount > 0 ? `• ${stats.unreadCount} unread messages 💬\n` : "") +
                (stats.tattooCount > 0 ? `• ${stats.tattooCount} pending tattoo reviews 💍\n` : "") +
                (stats.noSlotCount > 0 ? `• ${stats.noSlotCount} candidates with no slots 🗓️\n` : "") +
                `\n`;
        }

        let text = `🚀 <b>HR Hub</b>\n\n` +
            urgentText +
            `📥 <b>New:</b> ${stats.newCandidates}\n` +
            `📅 <b>Interviews Today:</b> ${stats.todayInterviews}\n`;

        return text;
    },

    async getCandidatesWaitingDecision() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.INTERVIEW_COMPLETED, { hrDecision: null });
    },

    async getCandidateDetails(candId: string) {
        return candidateRepository.findById(candId);
    },

    async makeDecision(api: any, candId: string, decision: "ACCEPTED" | "REJECTED", adminId?: string) {
        const initialCand = await this.getCandidateDetails(candId);
        if (!initialCand) return false;

        await candidateRepository.update(candId, {
            // We DON'T update status immediately. 
            // Instead, we leave it as INTERVIEW_COMPLETED so the worker can 
            // send the notification after 6 hours and THEN update the status.
            hrDecision: decision,
            notificationSent: false,
            materialsSent: false,
            hasUnreadMessage: false, // Mark as read once decision is made
            ...(decision === "ACCEPTED" ? { isWaitlisted: false } : {})
        });

        const cand = await this.getCandidateDetails(candId);
        if (!cand) return false;

        // Sync channel access
        await accessService.syncUserAccess(cand.user.telegramId, `HR Decision: ${decision}`);

        // Log to Timeline
        const { timelineRepository } = await import("../repositories/timeline-repository.js");
        await timelineRepository.createEvent(cand.user.id, 'SYSTEM_EVENT', 'ADMIN', `HR прийняв рішення: ${decision}`, {
            decision,
            adminId: adminId || 'unknown'
        });

        return true;
    },

    async sendOffer(api: any, candId: string) {
        const cand = await this.getCandidateDetails(candId);
        if (!cand || cand.notificationSent) return false;

        const text = getOfferWelcomeText(cand);

        try {
            const { trackUserMessage } = await import("../utils/cleanup.js");
            const msg = await api.sendMessage(Number(cand.user.telegramId), text, { parse_mode: "HTML" });
            if (msg) await trackUserMessage(Number(cand.user.telegramId), msg.message_id);

            await candidateRepository.update(candId, {
                status: CandidateStatus.ACCEPTED,
                notificationSent: true
            });

            // Notify Mentors ONLY AFTER offer is actually sent
            await notifyMentors(api, cand);

            return true;
        } catch (e) {
            logger.error({ err: e, candId }, "Failed to send offer message");
            return false;
        }
    },

    async approveTattoo(api: any, candId: string) {
        const cand = await this.getCandidateDetails(candId);
        if (!cand) return false;

        await candidateRepository.update(candId, { status: CandidateStatus.SCREENING });

        const { cleanupUserSessionMessages, trackUserMessage } = await import("../utils/cleanup.js");
        const { CANDIDATE_TEXTS } = await import("../constants/candidate-texts.js");

        await cleanupUserSessionMessages(api, Number(cand.user.telegramId));
        const msg = await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["hr-manual-review-approved"]).catch(() => { });
        if (msg) await trackUserMessage(Number(cand.user.telegramId), msg.message_id);

        return true;
    },

    async rejectCandidate(api: any, candId: string, reason: "APPEARANCE" | "NOSHOW" | "GENERAL" = "GENERAL") {
        const cand = await this.getCandidateDetails(candId);
        if (!cand) return false;

        await candidateRepository.update(candId, {
            status: CandidateStatus.REJECTED,
            hrDecision: reason === "NOSHOW" ? "NOSHOW" : "REJECTED"
        });

        const { STAFF_TEXTS } = await import("../constants/staff-texts.js");
        const tid = Number(cand.user.telegramId);

        let text = (STAFF_TEXTS as any)["hr-rejection-general"] || "На жаль, ми не можемо запропонувати тобі співпрацю на даний момент. Дякуємо за інтерес!";
        if (reason === "APPEARANCE") text = (STAFF_TEXTS as any)["hr-rejection-appearance"];


        try {
            await api.sendMessage(tid, text);
        } catch (e) { }

        await accessService.syncUserAccess(cand.user.telegramId, `HR Rejected: ${reason}`);
        return true;
    },

    async inviteCandidate(api: any, candId: string) {
        const cand = await this.getCandidateDetails(candId);
        if (!cand) return false;

        const { extractFirstName } = await import("../utils/string-utils.js");
        const { cleanupUserSessionMessages, trackUserMessage } = await import("../utils/cleanup.js");
        const { STAFF_TEXTS } = await import("../constants/staff-texts.js");

        const tid = Number(cand.user.telegramId);

        await cleanupUserSessionMessages(api, tid);
        const locName = cand.location?.name || cand.city || 'вашого міста';
        const msg = await api.sendMessage(tid,
            STAFF_TEXTS["hr-info-broadcast-item"]({ locationName: locName } as any),
            {
                reply_markup: new InlineKeyboard()
                    .text(STAFF_TEXTS["hr-btn-choose-time"], "start_scheduling").row()
                    .text(STAFF_TEXTS["hr-btn-invite-decline"], "decline_invite")
            }
        );

        if (msg) await trackUserMessage(tid, msg.message_id);
        await candidateRepository.update(candId, {
            notificationSent: true,
            status: CandidateStatus.SCREENING,
            interviewInvitedAt: new Date()
        });

        return true;
    },

    async getBroadcastCandidates(city: string, includeNotified: boolean = false, locationId?: string | null, limit?: number) {
        // Fetch candidates who either:
        // 1. Are in SCREENING and not yet notified (or includeNotified is true)
        // 2. Are in WAITLIST (already waited for a long time)
        const candidates = await prisma.candidate.findMany({
            where: {
                city,
                OR: [
                    { status: CandidateStatus.SCREENING, appearance: { not: null }, isOtherCity: false },
                    { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: { in: [FunnelStep.INITIAL_TEST, FunnelStep.INTERVIEW] } }
                ],
                ...(locationId ? { locationId } : {})
            },
            include: { user: true },
            orderBy: {
                // Older candidates first
                id: 'asc' // Assuming cuid or similar that is roughly time-sortable. Ideally createdAt if available.
            }
        });

        const filtered = candidates.filter(c => {
            if (c.status === CandidateStatus.WAITLIST) return true; // Waitlist candidates always included
            return includeNotified || !c.notificationSent;
        });

        return limit ? filtered.slice(0, limit) : filtered;
    },
    async markInterviewInvitationSent(candId: string) {
        await candidateRepository.update(candId, { notificationSent: true });
    },

    async markAsScreening(candId: string) {
        await candidateRepository.update(candId, { status: CandidateStatus.SCREENING });
    },

    async getWaitlistBroadcastCandidates(locId: string) {
        return candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, { locationId: locId });
    },

    async getWaitlistCandidatesByLocation(locId: string) {
        return candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, { locationId: locId });
    },

    async getNewCandidates(take = 10) {
        return candidateRepository.findByStatusWithUser(CandidateStatus.SCREENING, {
            interviewSlotId: null,
            appearance: { not: null },
            isOtherCity: false
        });
    },

    async getManualReviewCandidates() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.MANUAL_REVIEW as any);
    },

    async getUnreadCandidates() {
        return candidateRepository.findUnreadByScope("HR");
    },

    async getWaitlistCandidates() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
            isWaitlisted: true,
            currentStep: { in: [FunnelStep.INITIAL_TEST, FunnelStep.INTERVIEW] }
        });
    },

    async getWaitlistCities() {
        const candidates = await this.getWaitlistCandidates();
        const activeCities = await locationRepository.findAllCities(true);
        const cities = new Set<string>();
        candidates.forEach(c => {
            if (c.city && activeCities.includes(c.city)) {
                cities.add(c.city);
            }
        });
        return Array.from(cities).sort();
    },

    async getWaitlistLocationsByCity(city: string) {
        const candidates = await this.getWaitlistCandidates();
        const cityCands = candidates.filter(c => c.city === city);
        const locations: Record<string, { id: string | null, name: string, count: number }> = {};

        cityCands.forEach(c => {
            const locId = c.locationId || "unassigned";
            const locName = c.location?.name || "Unassigned";
            if (!locations[locId]) locations[locId] = { id: c.locationId, name: locName, count: 0 };
            locations[locId]!.count++;
        });

        return Object.values(locations).sort((a, b) => b.count - a.count);
    },

    async getWaitlistCandidatesByLocationPaginated(city: string, locationId: string | null, page: number, pageSize: number = 5) {
        const candidates = await this.getWaitlistCandidates();
        const filtered = candidates.filter(c =>
            c.city === city &&
            (locationId === null ? c.locationId === null : c.locationId === locationId)
        );

        const total = filtered.length;
        const totalPages = Math.ceil(total / pageSize);
        const items = filtered.slice((page - 1) * pageSize, page * pageSize);

        return { items, total, totalPages, currentPage: page };
    },

    // Тип 1: Очікують місця (повна команда при первинному відборі)
    async getWaitlistLocationFull() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
            isWaitlisted: true,
            currentStep: FunnelStep.INITIAL_TEST
        });
    },

    // Тип 2: Отримали запрошення, але не знайшли зручного слоту
    async getWaitlistNoSlot() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
            isWaitlisted: true,
            currentStep: FunnelStep.INTERVIEW
        });
    },

    async getWaitlistLocations() {
        const locations = await locationRepository.findWithWaitlist();
        return locations.sort((a, b) => ((b as any)._count.candidates || 0) - ((a as any)._count.candidates || 0));
    },

    async getCityRecruitmentStats() {
        const locations = await locationRepository.findAllActive();
        const { getLocationPriority } = await import("../utils/location-helpers.js");

        const results: any[] = [];

        // 1. Map locations
        for (const loc of locations) {
            const candidates = await prisma.candidate.findMany({
                where: {
                    locationId: loc.id,
                    OR: [
                        { status: CandidateStatus.SCREENING, appearance: { not: null }, isOtherCity: false },
                        { status: CandidateStatus.WAITLIST, isWaitlisted: true, currentStep: { in: [FunnelStep.INITIAL_TEST, FunnelStep.INTERVIEW] } }
                    ]
                }
            });
            // ONLY count those who haven't been notified yet (or waitlist)
            const freshCount = candidates.filter(c => c.status === CandidateStatus.WAITLIST || !c.notificationSent).length;

            // Show location if it has an active need OR fresh candidates
            if (freshCount > 0 || loc.neededCount > 0) {
                const priority = getLocationPriority(loc.neededCount);
                results.push({
                    city: loc.city,
                    locationName: loc.name,
                    locationId: loc.id,
                    candidateCount: freshCount,
                    totalNeeded: loc.neededCount,
                    priority
                });
            }
        }

        // Sort by priority (URGENT first) then by city
        return results.sort((a, b) => {
            const pMap: Record<string, number> = { 'URGENT': 0, 'ACTIVE': 1, 'FULL': 2 };
            const pDiff = (pMap[a.priority] ?? 99) - (pMap[b.priority] ?? 99);
            if (pDiff !== 0) return pDiff;
            return a.city.localeCompare(b.city);
        });
    },

    async hasCandidatesWaitlisted(locId: string) {
        const count = await candidateRepository.countByLocationAndStatus(locId, CandidateStatus.WAITLIST);
        return count > 0;
    },

    async getOccupiedDates() {
        const now = new Date();
        const startOfLookback = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0);
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

        // 1. Get ALL future slots (booked or free)
        // 2. Get PAST slots ONLY IF they are booked AND have no HR decision
        const slots = await prisma.interviewSlot.findMany({
            where: {
                OR: [
                    { startTime: { gte: startOfToday } },
                    {
                        startTime: { gte: startOfLookback, lt: startOfToday },
                        isBooked: true,
                        candidate: {
                            status: { in: [CandidateStatus.INTERVIEW_SCHEDULED, CandidateStatus.INTERVIEW_COMPLETED, CandidateStatus.DECISION_PENDING] },
                            hrDecision: null as any
                        }
                    }
                ]
            },
            select: { startTime: true },
            orderBy: { startTime: 'asc' }
        });

        const formatKyivDate = (date: Date) => {
            return date.toLocaleDateString('uk-UA', {
                day: '2-digit',
                month: '2-digit',
                timeZone: 'Europe/Kyiv'
            });
        };

        const uniqueDates = Array.from(new Set(slots.map(s => formatKyivDate(s.startTime!))));
        return uniqueDates;
    },

    async getDaySlots(dateStr: string) {
        const parts = dateStr.split('.');
        if (parts.length < 2) return [];
        const day = parseInt(parts[0]!);
        const month = parseInt(parts[1]!);
        const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
        const targetDate = new Date(year, month - 1, day);
        const windowStart = new Date(targetDate.getTime() - 24 * 60 * 60 * 1000);
        const windowEnd = new Date(targetDate.getTime() + 48 * 60 * 60 * 1000);

        const slots = await interviewRepository.findWithCandidateInWindow(windowStart, windowEnd);

        const formatKyivDate = (date: Date) => {
            return date.toLocaleDateString('uk-UA', {
                day: '2-digit',
                month: '2-digit',
                timeZone: 'Europe/Kyiv'
            });
        };

        // Show ALL slots for the selected day
        return slots.filter(s => formatKyivDate(s.startTime) === dateStr);
    },

    async getInterviewSlot(slotId: string) {
        return interviewRepository.findSlotWithCandidate(slotId);
    },

    async completeInterview(slotId: string) {
        const slot = await this.getInterviewSlot(slotId);
        if (!slot || !slot.candidate) return null;

        await candidateRepository.update(slot.candidate.id, {
            status: CandidateStatus.INTERVIEW_COMPLETED,
            interviewCompletedAt: new Date(),
            notificationSent: false,
            materialsSent: false,
            hrDecision: null
        });

        // Cleanup old messages (Interview scheduled/links) when interview is completed
        const { cleanupUserSessionMessages, trackUserMessage } = await import("../utils/cleanup.js");
        const { Bot } = await import("grammy");
        const botToken = process.env.BOT_TOKEN;
        if (botToken) {
            const bot = new Bot(botToken);
            await cleanupUserSessionMessages(bot as any, Number(slot.candidate.user.telegramId));

            // The actual message is sent outside this service in some cases, 
            // but for safety we ensure the next message sent will be tracked.
        }

        return {
            candidate: slot.candidate,
            telegramId: Number(slot.candidate.user.telegramId),
            text: getPostInterviewSummaryText(slot.candidate)
        };
    },

    async getStagingCandidates() {
        return candidateRepository.findByStatusWithUser([CandidateStatus.STAGING_SETUP, CandidateStatus.STAGING_ACTIVE], {
            currentStep: FunnelStep.FIRST_SHIFT
        });
    },

    async getCandidatesReadyForSchedule() {
        return candidateRepository.findByStatusWithUser(CandidateStatus.READY_FOR_HIRE, {
            currentStep: FunnelStep.FIRST_SHIFT
        });
    },

    async confirmFinalSchedule(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        await candidateRepository.update(candId, { status: CandidateStatus.HIRED });

        // Sync channel access (now they are hired, so they stay)
        await accessService.syncUserAccess(cand.user.telegramId, "Candidate Hired (Final Step)");

        // Log to Timeline
        const { timelineRepository } = await import("../repositories/timeline-repository.js");
        await timelineRepository.createEvent(cand.user.id, 'STATUS_CHANGE', 'SYSTEM', `Кандидат офіційно найнятий (HIRED). Початок роботи.`, { status: 'HIRED' });

        // Synchronize Team from Google Sheets to ensure everything is up to date
        try {
            const { scheduleSyncService } = await import("./schedule-sync.js");
            await scheduleSyncService.syncTeam();
        } catch (e) {
            logger.error({ err: e }, "Failed to sync team after hiring");
        }

        const { MENTOR_IDS } = await import("../config.js");
        const mentorId = MENTOR_IDS.length > 0 ? MENTOR_IDS[0] : null;

        return {
            candidate: cand,
            mentorId: mentorId,
            candidateId: Number(cand.user.telegramId)
        };
    },

    async completeOfflineStaging(candId: string, passed: boolean) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        if (passed) {
            await candidateRepository.update(candId, {
                status: CandidateStatus.READY_FOR_HIRE,
                currentStep: FunnelStep.FIRST_SHIFT // Moving to next stage: Real work
            });
        } else {
            await candidateRepository.update(candId, { status: CandidateStatus.REJECTED });
        }

        // Sync channel access
        await accessService.syncUserAccess(cand.user.telegramId, `Offline Staging result: ${passed ? 'PASSED' : 'FAILED'}`);

        return { candidate: cand, passed };
    },

    async markNoShow(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return false;

        await candidateRepository.update(candId, {
            status: CandidateStatus.REJECTED,
            hrDecision: "NOSHOW"
        });

        // Sync channel access
        await accessService.syncUserAccess(cand.user.telegramId, "HR Decision: REJECTED (No Show)");

        // Cleanup old messages (Interview scheduled/links)
        const { cleanupUserSessionMessages } = await import("../utils/cleanup.js");
        const { Bot } = await import("grammy");
        const botToken = process.env.BOT_TOKEN;
        if (botToken) {
            const bot = new Bot(botToken);
            await cleanupUserSessionMessages(bot as any, Number(cand.user.telegramId));
        }

        // Log to Timeline
        const { timelineRepository } = await import("../repositories/timeline-repository.js");
        await timelineRepository.createEvent(cand.user.id, 'STATUS_CHANGE', 'ADMIN', `Кандидат не з'явився на співбесіду (NOSHOW).`, { status: 'NOSHOW' });

        return true;
    },

    async rescheduleCandidate(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return false;

        // 1. Find and cancel slot if any (to free it up)
        if (cand.interviewSlotId) {
            const { bookingService } = await import("./booking-service.js");
            await bookingService.cancelInterviewSlot(cand.interviewSlotId);
        }

        // 2. Set status back to WAITLIST so they can book again
        await candidateRepository.update(candId, {
            status: CandidateStatus.WAITLIST,
            hrDecision: null,
            notificationSent: false,
            currentStep: FunnelStep.INTERVIEW
        });

        // 3. Log to Timeline
        const { timelineRepository } = await import("../repositories/timeline-repository.js");
        await timelineRepository.createEvent(cand.user.id, 'STATUS_CHANGE', 'ADMIN', `Кандидата перенаправлено на повторний вибір часу (Reschedule).`);

        return true;
    },

    async getUpcomingSessions() {
        const now = new Date();
        const sessions = await interviewRepository.findActiveSessionsAfter(now);
        const weekdays = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

        // Group by day and add slot stats
        const results = sessions.map(s => {
            const booked = s.slots.filter(sl => sl.isBooked).length;
            const total = s.slots.length;
            const free = total - booked;

            const startDate = new Date(s.startTime);
            const dayName = weekdays[startDate.getDay()];
            const dateStr = startDate.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });

            const formatTime = (d: Date) => d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
            const timeRange = `${formatTime(s.startTime)}–${formatTime(s.endTime)}`; // Using en-dash

            return {
                id: s.id,
                dayName,
                dateStr,
                timeRange,
                booked,
                total,
                free,
                canDelete: booked === 0
            };
        });

        return results.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 10);
    },

    async deleteInterviewSlot(id: string) {
        return interviewRepository.deleteSlot(id);
    },

    async deleteSession(sessionId: string) {
        return interviewRepository.deleteSession(sessionId);
    },

    async sendStagingNotifications(api: any, candId: string) {
        const { shortenName, extractFirstName } = await import("../utils/string-utils.js");
        const candRecord = await prisma.candidate.findUnique({
            where: { id: candId },
            include: { user: true, location: true, firstShiftPartner: { include: { user: true } } }
        });

        if (!candRecord || !candRecord.location || !candRecord.firstShiftDate) {
            logger.error({ candId }, "Cannot send staging notifications: missing base data");
            return false;
        }

        // --- SMART PARTNER LOOKUP ---
        let member = candRecord.firstShiftPartner as any;
        if (!member) {
            logger.warn({ candId }, "Cannot send staging notifications: partner missing");
            return false;
        }

        const dateStr = new Date(candRecord.firstShiftDate).toLocaleDateString('uk-UA');
        const stagingTime = candRecord.firstShiftTime || "15:00-17:00";
        const stagingLoc = candRecord.location;

        let candidateNotified = false;
        let partnerNotified = false;
        const candName = shortenName(candRecord.fullName || "Кандидатка");
        const partnerName = shortenName(member.fullName);

        // Notify candidate (UA, Apple Style)
        try {
            let locText = `📍 <b>${stagingLoc?.name || '—'}</b>`;
            if (stagingLoc?.address) locText += `\n🏠 Адреса: <b>${stagingLoc.address}</b>`;
            if (stagingLoc?.googleMapsLink) locText += `\n🗺️ <a href="${stagingLoc.googleMapsLink}">Переглянути на картах</a>`;

            const firstName = extractFirstName(candRecord.fullName || "");
            const partnerShortName = shortenName(member.fullName);
            const partnerUser = (member as any).user;
            const partnerUsername = partnerUser?.username;

            const candMsg = CANDIDATE_TEXTS["admin-staging-confirmation"](firstName, locText, dateStr, stagingTime, partnerShortName);

            const kb = new InlineKeyboard();
            if (partnerUsername) kb.url("💬 Написати напарнику", `https://t.me/${partnerUsername}`).row();
            else if (partnerUser?.telegramId) kb.url("💬 Написати напарнику", `tg://user?id=${partnerUser.telegramId}`).row();

            kb.text("❌ Не зможу прийти", `cancel_staging_${candId}`).row();
            kb.text("👨‍💼 Написати Адміну", "contact_hr");

            await api.sendMessage(Number(candRecord.user.telegramId), candMsg, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
            candidateNotified = true;
        } catch (e) { logger.error({ err: e }, "Failed to notify candidate about staging"); }

        // Notify partner photographer (UA, Apple Style)
        try {
            const partnerUser = (member as any).user;
            if (partnerUser?.telegramId) {
                const candShortName = shortenName(candRecord.fullName || "Кандидатка");
                const candUsername = candRecord.user.username;

                const partnerMsg = `🤝 <b>Довіряємо тобі наставництво!</b>\n\n` +
                    `Ти — серце нашої команди для нової дівчини. Твій досвід допоможе їй закохатися в роботу так само, як ми. 🤍\n\n` +
                    `👤 <b>${candShortName}</b>\n` +
                    `📍 <b>${stagingLoc?.name || '—'}</b>\n` +
                    `🗓 <b>${dateStr} • ${stagingTime}</b>\n\n` +
                    `Зустрінь її на локації, покажи техніку та наші фішки. Твій приклад — найкраще навчання! 📸`;

                const partnerKb = new InlineKeyboard();
                if (candUsername) partnerKb.url("💬 Написати стажерці", `https://t.me/${candUsername}`);
                else partnerKb.url("💬 Написати стажерці", `tg://user?id=${candRecord.user.telegramId}`);

                await api.sendMessage(Number(partnerUser.telegramId), partnerMsg, { parse_mode: "HTML", reply_markup: partnerKb });
                partnerNotified = true;
            }
        } catch (e) { logger.error({ err: e }, "Failed to notify partner about staging"); }

        // Update candidate status
        await prisma.candidate.update({
            where: { id: candId },
            data: {
                status: CandidateStatus.STAGING_ACTIVE,
                currentStep: FunnelStep.FIRST_SHIFT,
                notificationSent: true,
                statusChangedAt: new Date()
            }
        });

        return { candidateNotified, partnerNotified, candName, partnerName };
    },

    async notifyWaitlist(api: any, city?: string) {
        const candidates = await candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
            isWaitlisted: true,
            currentStep: FunnelStep.INTERVIEW,
            ...(city ? { city } : {})
        });

        let successCount = 0;
        for (const cand of candidates) {
            try {
                const firstName = extractFirstName(cand.fullName || "");
                const text = `Привіт, ${firstName}! ✨\n\nЗ'явилися нові вільні вікна для співбесіди. Тисни кнопку нижче, щоб обрати зручний час для здзвону! 👇`;
                const kb = new InlineKeyboard().text("🗓️ Обрати час", "start_scheduling");

                await api.sendMessage(Number(cand.user.telegramId), text, { reply_markup: kb });

                await candidateRepository.update(cand.id, {
                    status: CandidateStatus.SCREENING,
                    isWaitlisted: false,
                    notificationSent: true
                });
                successCount++;
            } catch (e) {
                logger.error({ err: e, userId: cand.user.telegramId }, "Failed to notify HR waitlist candidate");
            }
        }
        return successCount;
    }
};

function getOfferWelcomeText(candidate: any) {
    const firstName = extractFirstName(candidate.fullName || "");

    return `<b>Вітаємо, ${firstName}! Ти успішно пройшла співбесіду. 📸✨</b>\n\n` +
        `Ми з радістю запрошуємо тебе пройти навчання та познайомитися з нашою командою ближче.\n\n` +
        `<b>Що далі?</b>\n` +
        `Найближчим часом тобі напише наставниця. Вона допоможе зорієнтуватися та надішле все необхідне для старту.\n\n` +
        `До зустрічі в PlayPhoto! 🤍🕊️`;
}
