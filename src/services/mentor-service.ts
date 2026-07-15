import { InlineKeyboard, type Api } from "grammy";
import logger from "../core/logger.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { accessService } from "./access-service.js";
import { ADMIN_IDS, KNOWLEDGE_BASE_LINK, NDA_LINK, PHOTOGRAPHER_GUIDE_LINK } from "../config.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { isBotBlocked, handleBlockedCandidate } from "../utils/bot-blocked.js";
import { createKyivDate } from "../utils/bot-utils.js";
import { getLocationDetails } from "../utils/location-data-helper.js";
import { cleanupUserSessionMessages } from "../utils/cleanup.js";
import prisma from "../db/core.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { audit } from "../core/audit-logger.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";
import { hiringNeedsService } from "./hiring-needs-service.js";
import { googleCalendar } from "./google-calendar.js";
import { createRichMessageBot } from "../core/rich-message-api.js";

export class MentorService {
    private hasBookedOverlap(overlap: {
        slots?: Array<{
            isBooked?: boolean;
            candidate?: { id?: string | null } | null;
            candidateDiscovery?: { id?: string | null } | null;
        }>;
    } | null) {
        return Boolean(overlap?.slots?.some((slot) =>
            slot.isBooked && (slot.candidate || slot.candidateDiscovery)
        ));
    }

    private getKyivStartOfToday() {
        const kyivNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        kyivNow.setHours(0, 0, 0, 0);
        return kyivNow;
    }

    private getMentorWaitlistWhere() {
        return {
            status: { in: [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST] },
            isWaitlisted: true,
            currentStep: FunnelStep.TRAINING
        };
    }

    async getStats() {
        const accepted = await candidateRepository.findByStatusWithUser([CandidateStatus.ACCEPTED, CandidateStatus.INTERVIEW_COMPLETED], {
            isWaitlisted: false,
            hrDecision: "ACCEPTED",
            notificationSent: true
        });

        const newAcceptedCount = accepted.filter(c => !c.materialsSent).length;
        const awaitingBookingCount = accepted.filter(c => c.materialsSent && !c.discoverySlotId).length;
        const readyForTrainingCount = await candidateRepository.countByStatus(CandidateStatus.DISCOVERY_COMPLETED);
        const unreadMessagesCount = await candidateRepository.countUnreadByScope("MENTOR");

        const today = new Date();
        const start = new Date(today.setHours(0, 0, 0, 0));
        const end = new Date(today.setHours(23, 59, 59, 999));

        const trainingToday = await trainingRepository.countBookedSlotsByDateRange(start, end);

        // Overdue meetings: booked slots in the past, still in SCHEDULED status
        const overdue = await prisma.trainingSlot.count({
            where: {
                startTime: { lt: new Date() },
                isBooked: true,
                OR: [
                    { candidate: { status: CandidateStatus.TRAINING_SCHEDULED } },
                    { candidateDiscovery: { status: "DISCOVERY_SCHEDULED" as any } }
                ]
            }
        });

        const manualCount = await candidateRepository.countByStatus(CandidateStatus.MENTOR_MANUAL);

        return {
            actionNeeded: manualCount,
            calendarCount: trainingToday + overdue,
            trainingToday,
            overdue,
            newAcceptedCount,
            awaitingBookingCount,
            readyForTrainingCount,
            manualCount,
            waitlistCount: 0,
            unreadMessagesCount
        };
    }

    async getHubText() {
        const stats = await this.getStats();

        return `🎓 <b>Mentor Hub</b>\n\n` +
            `📥 <b>Inbox:</b> ${stats.manualCount}\n`;
    }

    async getWaitlistCount() {
        return await prisma.candidate.count({
            where: this.getMentorWaitlistWhere()
        });
    }

    async getCandidateForMentorProfile(candId: string) {
        return candidateRepository.findById(candId);
    }

    async getCandidateDetails(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        const age = cand.birthDate ? new Date().getFullYear() - new Date(cand.birthDate).getFullYear() : '?';
        const locName = cand.location?.name || 'Not selected';

        const statusMap: Record<string, string> = {
            "ACCEPTED": cand.materialsSent ? "📩 Materials sent" : "🆕 New",
            "MENTOR_MANUAL": "👨‍🏫 Manual mentoring",
            "WAITLIST": "⏳ Waitlist",
            "WAITLIST_HR": "⏳ Waitlist (HR)",
            "WAITLIST_MENTOR": "⏳ Waitlist (Mentor)",
            "DISCOVERY_SCHEDULED": "🔍 Discovery scheduled",
            "DISCOVERY_COMPLETED": "✅ Discovery passed",
            "TRAINING_SCHEDULED": "📅 Training scheduled",
            "TRAINING_COMPLETED": "📝 Training completed",
            "HIRED": "🚀 Active Team",
            "REJECTED": "❌ Rejected"
        };

        if (!cand.user) {
            logger.error({ candId }, "Candidate user record missing in database");
            return {
                cand,
                text: `👤 <b>${cand.fullName}</b>\n` +
                    `🎂 Age: ${age}\n` +
                    `🏙️ City: ${cand.city}\n` +
                    `📍 Location: ${locName}\n` +
                    `⚠️ <b>User record missing in database</b>\n` +
                    `🏷️ Status: <b>${statusMap[cand.status] || cand.status}</b>`
            };
        }

        const text = `👤 <b>${cand.fullName}</b>\n` +
            `🎂 Age: ${age}\n` +
            `🏙️ City: ${cand.city}\n` +
            `📍 Location: ${locName}\n` +
            `📞 Telegram: @${cand.user.username || 'none'}\n` +
            `🏷️ Status: <b>${statusMap[cand.status] || cand.status}</b>`;

        return { cand, text };
    }

    async getCandidates(isWaitlist: boolean) {
        if (isWaitlist) {
            return await candidateRepository.findByStatusWithUser(
                [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST],
                this.getMentorWaitlistWhere()
            );
        }
        return await candidateRepository.findByStatusWithUser([CandidateStatus.ACCEPTED, CandidateStatus.INTERVIEW_COMPLETED], {
            isWaitlisted: false,
            hrDecision: "ACCEPTED",
            notificationSent: true
        });
    }

    async getCandidatesWithUnreadMessages(scope: "HR" | "MENTOR") {
        return candidateRepository.findUnreadByScope(scope);
    }

    async getActionNeededCandidates() {
        const accepted = await candidateRepository.findByStatusWithUser([CandidateStatus.ACCEPTED, CandidateStatus.INTERVIEW_COMPLETED], {
            isWaitlisted: false,
            hrDecision: "ACCEPTED",
            notificationSent: true
        });
        const discoveryDone = await candidateRepository.findByStatusWithUser(CandidateStatus.DISCOVERY_COMPLETED, { isWaitlisted: false });

        // Кандидати, які потребують дії:
        // 1. Нові (немає матеріалів)
        // 2. Ті, що отримали матеріали, але не записались (!discoverySlotId)
        // 3. Ті, що пройшли Discovery (DISCOVERY_COMPLETED)
        const waitingForAction = accepted.filter(c => !c.discoverySlotId);
        const all = [...waitingForAction, ...discoveryDone];
        const board = await hiringNeedsService.getBoard();
        const urgencyByLocation = new Map(board.items.map((item) => [item.locationId, hiringNeedsService.getUrgencyRank(item.urgency)]));

        return all.sort((left, right) => {
            const leftUrgency = urgencyByLocation.get(left.locationId || "") || 0;
            const rightUrgency = urgencyByLocation.get(right.locationId || "") || 0;
            if (leftUrgency !== rightUrgency) return rightUrgency - leftUrgency;

            const leftTime = left.materialsSentAt ? new Date(left.materialsSentAt).getTime() : 0;
            const rightTime = right.materialsSentAt ? new Date(right.materialsSentAt).getTime() : 0;
            return leftTime - rightTime;
        });
    }

    async sendMaterials(api: any, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        // Guard: only candidates who passed HR review can receive materials
        const isHRApproved = cand.hrDecision === "ACCEPTED";
        const isAlreadyInMentorFlow = cand.currentStep === FunnelStep.TRAINING && cand.materialsSent;

        if (!isHRApproved && !isAlreadyInMentorFlow) {
            logger.warn({ candId, status: cand.status, hrDecision: cand.hrDecision, currentStep: cand.currentStep },
                "⚠️ sendMaterials blocked: candidate not HR-approved");
            return null;
        }

        await candidateRepository.update(candId, {
            materialsSent: true,
            materialsSentAt: new Date(),
            status: "ACCEPTED",
            notificationSent: true, // Mark as notified so worker doesn't send duplicate welcome
            isWaitlisted: false
        });

        let msgText = "";
        if (cand.status === "WAITLIST" || cand.status === "WAITLIST_MENTOR") {
            msgText = `Привіт! ✨\n\nЗ'явилися нові вільні вікна для нашої короткої зустрічі-знайомства. Тисни кнопку нижче, щоб обрати зручний час! 👇`;
        } else if (cand.materialsSent && !cand.discoverySlotId) {
            msgText = `Привіт! ✨\n\nНагадую про запис на відеозустріч-знайомство. Чи вдалося ознайомитись з матеріалами? 📚\n\nОбери зручний час за кнопкою нижче! 👇`;
        } else {
            const channelLink = cand.user
                ? (await accessService.createInviteLink(cand.user.telegramId)) || accessService.staticJoinLink
                : accessService.staticJoinLink;
            msgText = CANDIDATE_TEXTS["discovery-invite"](KNOWLEDGE_BASE_LINK, channelLink, PHOTOGRAPHER_GUIDE_LINK);
        }

        audit({
            event: "candidate_materials_sent",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { fromStatus: cand.status, toStatus: CandidateStatus.ACCEPTED, currentStep: cand.currentStep }
        });

        if (cand.user) {
            await cleanupUserSessionMessages(createRichMessageBot(process.env.BOT_TOKEN!) as any, Number(cand.user.telegramId));
            return { telegramId: Number(cand.user.telegramId), text: msgText };
        }

        return null;
    }

    async notifyWaitlist(api: any) {
        const mentorWaitlist = await candidateRepository.findByStatusWithUser(
            [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST],
            this.getMentorWaitlistWhere()
        );

        // Only notify candidates who passed HR or are already in mentor flow.
        // notificationSent is a delivery bookkeeping flag, not a mentor visibility rule.
        const filtered = mentorWaitlist.filter(c =>
            c.hrDecision === "ACCEPTED" || c.materialsSent
        );

        let successCount = 0;
        for (const cand of filtered) {
            try {
                const text = `Привіт! ✨\n\nЗ'явилися нові вільні вікна для нашої зустрічі. Тисни кнопку нижче, щоб обрати зручний час! 👇`;
                const kb = new InlineKeyboard().text("🗓️ Обрати час", "start_training_scheduling");

                if (cand.user) {
                    await api.sendMessage(Number(cand.user.telegramId), text, { reply_markup: kb });

                    await candidateRepository.update(cand.id, {
                        status: "ACCEPTED",
                        isWaitlisted: false,
                        materialsSent: true,
                        materialsSentAt: new Date()
                    });
                    audit({
                        event: "candidate_waitlist_notified",
                        result: "success",
                        actorType: "system",
                        telegramId: cand.user.telegramId,
                        entityType: "candidate",
                        entityId: cand.id,
                        context: { fromStatus: cand.status, currentStep: cand.currentStep }
                    });
                    successCount++;
                }
            } catch (e: any) {
                if (isBotBlocked(e)) await handleBlockedCandidate(api, cand.id, cand.fullName || "Candidate");
                else logger.error({ err: e, userId: cand.user.telegramId }, "Failed to notify waitlist candidate");
            }
        }
        return successCount;
    }

    async completeDiscovery(api: any, candId: string, result: 'passed' | 'failed' | 'no_show') {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        if (result === 'passed') {
            await candidateRepository.update(candId, {
                status: "DISCOVERY_COMPLETED",
                discoveryCompletedAt: new Date()
            });
        } else {
            await candidateRepository.update(candId, { status: "REJECTED" });
            const msgKey = result === 'failed' ? "mentor-discovery-failed" : "mentor-discovery-no-show";
            if (cand.user) {
                await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS[msgKey]).catch(() => { });
            }
        }

        audit({
            event: "candidate_discovery_result_set",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { outcome: result, fromStatus: cand.status, toStatus: result === "passed" ? "DISCOVERY_COMPLETED" : "REJECTED" }
        });

        return { candidate: cand, result };
    }

    private async sendNdaRequest(api: Api, cand: any) {
        const firstName = extractFirstName(cand.fullName || "");
        const staticInfo = getLocationDetails(cand.location?.name);
        const jobDetails = `\n\n📍 <b>${cand.location?.name || cand.city}</b>\n` +
            `🏠 ${staticInfo?.address || cand.location?.address || ""}\n` +
            `📅 ${staticInfo?.schedule || cand.location?.schedule || "Пн-Пт 15:00-21:00"}\n` +
            `💰 ${staticInfo?.salary || cand.location?.salary || "25%"}`;

        const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", buildSignedCallback("cnda", cand.id));
        if (!cand.user) return;
        try {
            await api.sendMessage(Number(cand.user.telegramId),
                CANDIDATE_TEXTS["nda-request"](firstName, NDA_LINK, jobDetails),
                { parse_mode: "HTML", reply_markup: kb }
            );
        } catch (err: any) {
            if (isBotBlocked(err)) {
                await handleBlockedCandidate(api, cand.id, cand.fullName || "Candidate");
            } else {
                logger.error({ err, candidateId: cand.id, telegramId: cand.user.telegramId }, "Failed to send NDA message to candidate");
                const mainAdmin = ADMIN_IDS[0];
                if (mainAdmin) {
                    api.sendMessage(mainAdmin,
                        `⚠️ <b>NDA не доставлено!</b>\n\n👤 ${cand.fullName}\n📱 TG: ${cand.user.telegramId}\n\nСтатус змінено на NDA, але кандидатка не отримала кнопку.\nПричина: ${err?.description || err?.message || 'Unknown'}`,
                        { parse_mode: "HTML" }
                    ).catch(() => { });
                }
            }
        }
    }

    async completeTraining(api: any, candId: string, result: 'passed' | 'failed' | 'no_show') {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        if (result === 'passed') {
            await candidateRepository.update(candId, {
                status: CandidateStatus.NDA,
                trainingCompletedAt: new Date(),
                currentStep: FunnelStep.TRAINING,
                ndaSentAt: new Date()
            });

            await this.sendNdaRequest(api, cand);

        } else {
            await candidateRepository.update(candId, { status: "REJECTED" });
            await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["mentor-training-failed"]).catch(() => { });
        }

        audit({
            event: "candidate_training_result_set",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { outcome: result, fromStatus: cand.status, toStatus: result === "passed" ? CandidateStatus.NDA : "REJECTED" }
        });

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, `Training result: ${result.toUpperCase()}`);
        }
        return { candidate: cand, result };
    }

    async getManualMentorCandidates() {
        const candidates = await candidateRepository.findByStatusWithUser(CandidateStatus.MENTOR_MANUAL);
        return candidates.sort((left, right) => {
            const leftContacted = left.mentorManualContactedAt ? 1 : 0;
            const rightContacted = right.mentorManualContactedAt ? 1 : 0;
            if (leftContacted !== rightContacted) return leftContacted - rightContacted;
            const leftTime = left.mentorManualContactedAt ? new Date(left.mentorManualContactedAt).getTime() : 0;
            const rightTime = right.mentorManualContactedAt ? new Date(right.mentorManualContactedAt).getTime() : 0;
            return leftTime - rightTime;
        });
    }

    async setManualMentorContacted(candId: string, contacted: boolean) {
        const cand = await candidateRepository.findById(candId);
        if (!cand || cand.status !== CandidateStatus.MENTOR_MANUAL) return null;

        const updated = await candidateRepository.update(candId, {
            mentorManualContactedAt: contacted ? new Date() : null,
        });

        audit({
            event: "candidate_manual_mentor_contact_marked",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { contacted },
        });

        return { candidate: updated, success: true };
    }

    async acceptManualMentor(api: Api, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        await candidateRepository.update(candId, {
            status: CandidateStatus.NDA,
            trainingCompletedAt: new Date(),
            currentStep: FunnelStep.TRAINING,
            ndaSentAt: new Date(),
        });

        await this.sendNdaRequest(api, cand);

        audit({
            event: "candidate_manual_mentor_accepted",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { fromStatus: cand.status, toStatus: CandidateStatus.NDA },
        });

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, "Manual mentor accept");
        }
        return { candidate: cand, success: true };
    }

    async rejectManualMentor(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        await candidateRepository.update(candId, { status: CandidateStatus.REJECTED });

        audit({
            event: "candidate_manual_mentor_rejected",
            result: "success",
            actorType: "admin",
            telegramId: cand.user?.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { fromStatus: cand.status, toStatus: CandidateStatus.REJECTED },
        });

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, "Manual mentor reject");
        }
        return { candidate: cand, success: true };
    }

    async generateChannelLinkForMentor(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand?.user) return null;

        const link = await accessService.createInviteLink(cand.user.telegramId);

        audit({
            event: "mentor_channel_link_generated",
            result: link ? "success" : "failed",
            actorType: "admin",
            telegramId: cand.user.telegramId,
            entityType: "candidate",
            entityId: cand.id,
            context: { status: cand.status, generated: Boolean(link) },
        });

        return link;
    }

    async getTrainingSlots(date?: string) {
        if (!date) {
            const slots: any[] = await trainingRepository.findFutureSlots();
            return [...new Set(slots.map((s: any) => {
                const d = s.startTime.getDate();
                const m = s.startTime.getMonth() + 1;
                const y = s.startTime.getFullYear();
                return `${d < 10 ? '0' + d : d}.${m < 10 ? '0' + m : m}.${y}`;
            }))];
        } else {
            const parts = date.split('.');
            const day = parseInt(parts[0]!);
            const month = parseInt(parts[1]!);
            const year = parseInt(parts[2]!) || new Date().getFullYear();

            // Apple Style: Explicitly define the start and end of the day in Kyiv time
            const start = createKyivDate(year, month - 1, day, 0, 0);
            const end = createKyivDate(year, month - 1, day, 23, 59);
            return await trainingRepository.findActiveBookedSlotsByDateRange(start, end);
        }
    }

    async createTrainingSlotFromText(text: string, candId?: string) {
        const rangeRegex = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;
        const singleRegex = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/;

        const rangeMatch = text.match(rangeRegex);
        const singleMatch = text.match(singleRegex);

        if (!rangeMatch && !singleMatch) {
            return { success: false, error: "⚠️ Invalid format. Example: 05.03 10:00-12:00 or 05.03 10:00" };
        }

        const currentYear = new Date().getFullYear();
        let start: Date, end: Date;

        if (rangeMatch) {
            const [_, day, month, year, startH, startM, endH, endM] = rangeMatch.map(Number);
            start = createKyivDate(year || currentYear, month! - 1, day!, startH!, startM!);
            end = createKyivDate(year || currentYear, month! - 1, day!, endH!, endM!);
        } else {
            const [_, day, month, year, startH, startM] = singleMatch!.map(Number);
            start = createKyivDate(year || currentYear, month! - 1, day!, startH!, startM!);
            end = new Date(start.getTime() + 20 * 60 * 1000); // 20 min slot
        }

        if (start < new Date()) return { success: false, error: "⚠️ This time has already passed." };
        if (end <= start) return { success: false, error: "⚠️ End time must be after start time." };

        // 1. Robust overlap check with candidate status awareness
        const overlap = await prisma.trainingSession.findFirst({
            where: {
                AND: [
                    { startTime: { lt: new Date(end.getTime() - 1000) } },
                    { endTime: { gt: new Date(start.getTime() + 1000) } }
                ]
            },
            include: { slots: { include: { candidate: true, candidateDiscovery: true } } }
        });

        const isStrictlyOccupied = this.hasBookedOverlap(overlap);

        if (isStrictlyOccupied) {
            return { success: false, error: `✨ This time slot is already occupied. Please choose another window. 📅` };
        }

        // 2. Clean up unbooked or ghost sessions/slots in this range
        await prisma.trainingSession.deleteMany({
            where: {
                AND: [
                    { startTime: { lt: new Date(end.getTime() - 1000) } },
                    { endTime: { gt: new Date(start.getTime() + 1000) } }
                ]
            }
        }).catch(() => { });

        const totalDurationMinutes = (end.getTime() - start.getTime()) / 60000;
        const slots: { start: Date, end: Date }[] = [];

        if (totalDurationMinutes <= 25) {
            slots.push({ start, end });
        } else {
            let current = new Date(start);
            while (current.getTime() + 20 * 60 * 1000 <= end.getTime()) {
                const slotEnd = new Date(current.getTime() + 20 * 60 * 1000);
                slots.push({ start: new Date(current), end: slotEnd });
                current = new Date(current.getTime() + 30 * 60 * 1000); // 20 min slot + 10 min break
            }
        }

        if (slots.length === 0) return { success: false, error: "⚠️ No slots could be created in this window." };

        // Transaction: Create session and all slots atomically to prevent zombies
        await prisma.$transaction(async (tx) => {
            const session = await tx.trainingSession.create({ data: { startTime: start, endTime: end } });
            for (const s of slots) {
                await tx.trainingSlot.create({
                    data: {
                        startTime: s.start,
                        endTime: s.end,
                        isBooked: false,
                        sessionId: session.id
                    }
                });
            }
        });

        return { success: true, createdCount: slots.length, date: start.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' }) };
    }

    async bookTrainingSlotFromText(candId: string, text: string) {
        const regex = /^(\d{1,2})[./](\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/;
        const match = text.match(regex);
        if (!match) return { success: false, error: "⚠️ Invalid format. Example: 15.02 14:00" };

        const [_, day, month, year, startH, startM] = match.map(Number);
        const start = createKyivDate(year || new Date().getFullYear(), month! - 1, day!, startH!, startM!);

        // Apple Style: Unified 30-minute block (20m meeting + 10m break)
        const end = new Date(start.getTime() + 20 * 60 * 1000);
        const blockEnd = new Date(start.getTime() + 30 * 60 * 1000);

        const overlap = await prisma.trainingSession.findFirst({
            where: {
                AND: [
                    { startTime: { lt: blockEnd } },
                    { endTime: { gt: start } }
                ]
            },
            include: { slots: { include: { candidate: true, candidateDiscovery: true } } }
        });

        const isStrictlyOccupied = this.hasBookedOverlap(overlap);

        if (isStrictlyOccupied) {
            return { success: false, error: `✨ This time slot is already occupied. Please choose another window. 📅` };
        }

        // Clean up unbooked or ghost sessions in this range
        await prisma.trainingSession.deleteMany({
            where: {
                AND: [
                    { startTime: { lt: blockEnd } },
                    { endTime: { gt: start } }
                ]
            }
        }).catch(() => { });

        // Cancel old training slot if candidate already has one (reschedule safety net)
        const cand = await candidateRepository.findById(candId);
        if (cand?.trainingSlotId) {
            const { bookingService } = await import("./booking-service.js");
            await bookingService.cancelTrainingSlot(cand.trainingSlotId);
        }

        const session = await trainingRepository.createSession({ startTime: start, endTime: blockEnd });
        const slot = await trainingRepository.createSlot({
            startTime: start,
            endTime: end,
            isBooked: true,
            candidate: { connect: { id: candId } },
            trainingSession: { connect: { id: session.id } }
        });

        const candidateAfterCancel = await candidateRepository.findById(candId);
        const googleEvent = await googleCalendar.createEvent({
            summary: `Навчання: ${candidateAfterCancel?.fullName || "Кандидат"}`,
            description: `Кандидатка: ${candidateAfterCancel?.fullName || "Кандидат"}\nTelegram: @${candidateAfterCancel?.user?.username || 'немає'}`,
            startTime: start,
            endTime: end,
            calendarType: 'training'
        }).catch((err) => {
            logger.error({ err, candidateId: candId, slotId: slot.id }, "Manual training calendar event creation failed");
            return { eventId: undefined, meetLink: undefined };
        });

        await candidateRepository.update(candId, {
            status: "TRAINING_SCHEDULED",
            trainingMeetLink: googleEvent.meetLink || null,
            trainingSlot: { connect: { id: slot.id } }
        });

        if (googleEvent.eventId) {
            await trainingRepository.updateSlot(slot.id, { googleEventId: googleEvent.eventId });
        }

        const dateStr = start.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
        const timeStr = start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
        const channelLink = await accessService.createInviteLink(candidateAfterCancel?.user.telegramId!) || "https://t.me/+FuFRMGsvMktkNGFi";

        return {
            success: true,
            message: `✅ Scheduled for ${dateStr} ${timeStr}`,
            notification: {
                telegramId: Number(candidateAfterCancel?.user.telegramId),
                text: CANDIDATE_TEXTS["training-manual-invite"](dateStr, timeStr, channelLink, PHOTOGRAPHER_GUIDE_LINK)
            }
        };
    }

    async bookDiscoverySlotFromText(candId: string, text: string) {
        const regex = /^(\d{1,2})[./](\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/;
        const match = text.match(regex);
        if (!match) return { success: false, error: "⚠️ Invalid format. Example: 15.02 14:00" };

        const [_, day, month, year, startH, startM] = match.map(Number);
        const start = createKyivDate(year || new Date().getFullYear(), month! - 1, day!, startH!, startM!);
        const end = new Date(start.getTime() + 20 * 60 * 1000);
        const blockEnd = new Date(start.getTime() + 30 * 60 * 1000);

        const overlap = await prisma.trainingSession.findFirst({
            where: {
                AND: [
                    { startTime: { lt: blockEnd } },
                    { endTime: { gt: start } }
                ]
            },
            include: { slots: { include: { candidate: true, candidateDiscovery: true } } }
        });

        const isStrictlyOccupied = this.hasBookedOverlap(overlap);

        if (isStrictlyOccupied) {
            return { success: false, error: `✨ This time slot is already occupied. Please choose another window. 📅` };
        }

        await prisma.trainingSession.deleteMany({
            where: {
                AND: [
                    { startTime: { lt: blockEnd } },
                    { endTime: { gt: start } }
                ]
            }
        }).catch(() => { });

        // Cancel old discovery slot if candidate already has one (reschedule safety net)
        const cand = await candidateRepository.findById(candId);
        if (cand?.discoverySlotId) {
            const { bookingService } = await import("./booking-service.js");
            await bookingService.cancelDiscoverySlot(cand.discoverySlotId);
        }

        const session = await trainingRepository.createSession({ startTime: start, endTime: blockEnd });
        const slot = await trainingRepository.createSlot({
            startTime: start,
            endTime: end,
            isBooked: true,
            candidateDiscovery: { connect: { id: candId } },
            trainingSession: { connect: { id: session.id } }
        });

        const candidateAfterCancel = await candidateRepository.findById(candId);
        const googleEvent = await googleCalendar.createEvent({
            summary: `Знайомство: ${candidateAfterCancel?.fullName || "Кандидат"}`,
            description: `Кандидатка: ${candidateAfterCancel?.fullName || "Кандидат"}\nЛокація: ${candidateAfterCancel?.location?.name || 'Не вказано'}\nTelegram: @${candidateAfterCancel?.user?.username || 'немає'}`,
            startTime: start,
            endTime: end,
            calendarType: 'training'
        }).catch((err) => {
            logger.error({ err, candidateId: candId, slotId: slot.id }, "Manual discovery calendar event creation failed");
            return { eventId: undefined, meetLink: undefined };
        });

        await candidateRepository.update(candId, {
            status: "DISCOVERY_SCHEDULED",
            trainingMeetLink: googleEvent.meetLink || null,
            discoverySlot: { connect: { id: slot.id } }
        });

        if (googleEvent.eventId) {
            await trainingRepository.updateSlot(slot.id, { googleEventId: googleEvent.eventId });
        }

        const dateStr = start.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        const timeStr = start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });

        return {
            success: true,
            message: `✅ Scheduled for ${dateStr} ${timeStr}`,
            notification: {
                telegramId: Number(candidateAfterCancel?.user?.telegramId),
                text: CANDIDATE_TEXTS["mentor-manual-discovery-assigned"](dateStr, timeStr)
            }
        };
    }

    async deleteTrainingSlot(slotId: string) {
        try {
            await trainingRepository.deleteSlot(slotId);
            return true;
        } catch (e) {
            logger.error({ err: e }, "Error deleting training slot:");
            return false;
        }
    }

    async getBroadcastCandidates(city: string) {
        return await candidateRepository.findByCityAndStatus(city, "ACCEPTED", false).then(cands =>
            cands.filter(c => !c.materialsSent)
        );
    }

    async getBroadcastCities() {
        const candidates = await candidateRepository.findByStatus("ACCEPTED", false).then(cands =>
            cands.filter(c => !c.materialsSent)
        );
        const cityCounts: Record<string, number> = {};
        candidates.forEach((c) => {
            if (c.city) cityCounts[c.city] = (cityCounts[c.city] || 0) + 1;
        });
        return Object.keys(cityCounts).sort().map(city => ({ name: city, count: cityCounts[city] }));
    }
}

export const mentorService = new MentorService();
