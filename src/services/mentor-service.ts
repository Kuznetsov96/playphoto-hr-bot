import { InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { trainingRepository } from "../repositories/training-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import { accessService } from "./access-service.js";
import { KNOWLEDGE_BASE_LINK, NDA_LINK } from "../config.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { createKyivDate } from "../utils/bot-utils.js";
import { getLocationDetails } from "../utils/location-data-helper.js";
import { cleanupUserSessionMessages } from "../utils/cleanup.js";
import { Bot } from "grammy";
import prisma from "../db/core.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";

export class MentorService {
    async getStats() {
        const accepted = await candidateRepository.findByStatusWithUser([CandidateStatus.ACCEPTED, CandidateStatus.INTERVIEW_COMPLETED], {
            isWaitlisted: false,
            hrDecision: "ACCEPTED",
            notificationSent: true
        });
        
        const newAcceptedCount = accepted.filter(c => !c.materialsSent).length;
        const awaitingBookingCount = accepted.filter(c => c.materialsSent && !c.discoverySlotId).length;
        const readyForTrainingCount = await candidateRepository.countByStatus(CandidateStatus.DISCOVERY_COMPLETED);
        const waitlistCount = await this.getWaitlistCount();
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

        const onboardingCount = await prisma.candidate.count({ 
            where: { status: CandidateStatus.HIRED, isMentorLocked: true } 
        });

        return { 
            actionNeeded: newAcceptedCount + awaitingBookingCount + readyForTrainingCount, 
            calendarCount: trainingToday + overdue,
            trainingToday,
            overdue,
            onboardingCount, 
            newAcceptedCount, 
            awaitingBookingCount,
            readyForTrainingCount, 
            waitlistCount, 
            unreadMessagesCount 
        };
    }

    async getHubText() {
        const stats = await this.getStats();
        const totalInbox = stats.newAcceptedCount + stats.awaitingBookingCount + stats.readyForTrainingCount + stats.waitlistCount + stats.unreadMessagesCount;
        
        let calendarText = `📅 <b>Calendar:</b> ${stats.trainingToday}`;
        if (stats.overdue > 0) {
            calendarText = `📅 <b>Calendar:</b> ${stats.trainingToday} <a href="">(⚠️ ${stats.overdue} pending)</a>`;
        }

        return `🎓 <b>Mentor Hub</b>\n\n` +
            `📥 <b>Inbox:</b> ${totalInbox}\n` +
            `${calendarText}\n` +
            `🚀 <b>Onboarding:</b> ${stats.onboardingCount}\n`;
    }

    async getWaitlistCount() {
        return await prisma.candidate.count({
            where: {
                status: CandidateStatus.WAITLIST,
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            }
        });
    }

    async getCandidateDetails(candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        const age = cand.birthDate ? new Date().getFullYear() - new Date(cand.birthDate).getFullYear() : '?';
        const locName = cand.location?.name || 'Not selected';
        
        const statusMap: Record<string, string> = {
            "ACCEPTED": cand.materialsSent ? "📩 Materials sent" : "🆕 New",
            "WAITLIST": "⏳ Waitlist",
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
            return await candidateRepository.findByStatusWithUser(CandidateStatus.WAITLIST, {
                isWaitlisted: true,
                currentStep: FunnelStep.TRAINING
            });
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
        
        return [...waitingForAction, ...discoveryDone];
    }

    async sendMaterials(api: any, candId: string) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        const firstName = extractFirstName(cand.fullName || "");
        let msgText = "";
        
        if (cand.status === "WAITLIST") {
            msgText = `Привіт! ✨\n\nЗ'явилися нові вільні вікна для нашої короткої зустрічі-знайомства. Тисни кнопку нижче, щоб обрати зручний час! 👇`;
        } else if (cand.materialsSent && !cand.discoverySlotId) {
            msgText = `Привіт! ✨\n\nНагадую про запис на відеозустріч-знайомство. Чи вдалося ознайомитись з матеріалами? 📚\n\nОбери зручний час за кнопкою нижче! 👇`;
        } else {
            msgText = CANDIDATE_TEXTS["discovery-invite"](firstName, KNOWLEDGE_BASE_LINK);
        }

        await candidateRepository.update(candId, {
            materialsSent: true,
            materialsSentAt: new Date(),
            status: "ACCEPTED",
            notificationSent: true, // Mark as notified so worker doesn't send duplicate welcome
            isWaitlisted: false
        });

        if (cand.user) {
            await cleanupUserSessionMessages(new Bot(process.env.BOT_TOKEN!) as any, Number(cand.user.telegramId));
            return { telegramId: Number(cand.user.telegramId), text: msgText };
        }

        return null;
    }

    async notifyWaitlist(api: any) {
        const filtered = await candidateRepository.findByStatus("WAITLIST", true);
        
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
                    successCount++;
                }
            } catch (e) {
                logger.error({ err: e, userId: cand.user.telegramId }, "Failed to notify waitlist candidate");
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
                await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS[msgKey]).catch(() => {});
            }
        }

        return { candidate: cand, result };
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

            // Send NDA Request
            const firstName = extractFirstName(cand.fullName || "");
            const staticInfo = getLocationDetails(cand.location?.name);
            const jobDetails = `\n\n📍 <b>${cand.location?.name || cand.city}</b>\n` +
                              `🏠 ${staticInfo?.address || cand.location?.address || ""}\n` +
                              `📅 ${staticInfo?.schedule || cand.location?.schedule || "Пн-Пт 15:00-21:00"}\n` +
                              `💰 ${staticInfo?.salary || cand.location?.salary || "25%"}`;

            const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", `confirm_nda_${cand.id}`);
            if (cand.user) {
                await api.sendMessage(Number(cand.user.telegramId), 
                    CANDIDATE_TEXTS["nda-request"](firstName, NDA_LINK, jobDetails), 
                    { parse_mode: "HTML", reply_markup: kb }
                ).catch(() => {});
            }

        } else {
            await candidateRepository.update(candId, { status: "REJECTED" });
            await api.sendMessage(Number(cand.user.telegramId), CANDIDATE_TEXTS["mentor-training-failed"]).catch(() => {});
        }

        if (cand.user) {
            await accessService.syncUserAccess(cand.user.telegramId, `Training result: ${result.toUpperCase()}`);
        }
        return { candidate: cand, result };
    }

    async getOnboardingCandidates() {
        return await candidateRepository.findByStatusWithUser(CandidateStatus.HIRED, {
            isMentorLocked: true,
            fullName: { not: null } // Ensure they are valid
        }).then(cands => cands.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || '')));
    }

    async completeOnboarding(candId: string, success: boolean) {
        const cand = await candidateRepository.findById(candId);
        if (!cand) return null;

        if (success) {
            await candidateRepository.update(candId, { 
                status: "HIRED",
                isMentorLocked: false 
            });
            if (cand.locationId) {
                try { await locationRepository.update(cand.locationId, { neededCount: { decrement: 1 } }); } catch (e) { }
            }
            if (cand.user) {
                await accessService.syncUserAccess(cand.user.telegramId, "Onboarding result: SUCCESS (HIRED)");
            }
            return { candidate: cand, success: true };
        } else {
            await candidateRepository.update(candId, { status: "REJECTED" });
            if (cand.user) {
                await accessService.syncUserAccess(cand.user.telegramId, "Onboarding result: FAILED");
            }
            return { candidate: cand, success: false };
        }
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
            include: { slots: { include: { candidate: true } } }
        });

        // Only block if there's an active booking
        const isStrictlyOccupied = overlap && overlap.slots.some(s => 
            s.isBooked && s.candidate && !["HIRED", "REJECTED"].includes(s.candidate.status)
        );

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
        }).catch(() => {});

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

        return { success: true, createdCount: slots.length, date: start.toLocaleDateString('uk-UA') };
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
            include: { slots: { include: { candidate: true } } }
        });

        // Only block if there's an active booking
        const isStrictlyOccupied = overlap && overlap.slots.some(s => 
            s.isBooked && s.candidate && !["HIRED", "REJECTED"].includes(s.candidate.status)
        );

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
        }).catch(() => {});

        const session = await trainingRepository.createSession({ startTime: start, endTime: blockEnd });
        const slot = await trainingRepository.createSlot({
            startTime: start,
            endTime: end,
            isBooked: true,
            candidate: { connect: { id: candId } },
            trainingSession: { connect: { id: session.id } }
        });

        await candidateRepository.update(candId, {
            status: "TRAINING_SCHEDULED",
            trainingSlot: { connect: { id: slot.id } }
        });

        const dateStr = start.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
        const timeStr = start.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
        const channelLink = await accessService.createInviteLink((await candidateRepository.findById(candId))?.user.telegramId!) || "https://t.me/+FuFRMGsvMktkNGFi";
        
        return {
            success: true,
            message: `✅ Scheduled for ${dateStr} ${timeStr}`,
            notification: {
                telegramId: Number((await candidateRepository.findById(candId))?.user.telegramId),
                text: CANDIDATE_TEXTS["training-manual-invite"](dateStr, timeStr, channelLink, KNOWLEDGE_BASE_LINK)
            }
        };
    }

    async createTrainingSessionDirect(start: Date, end: Date) {
        return trainingRepository.createSession({ startTime: start, endTime: end });
    }

    async createTrainingSlotDirect(start: Date, end: Date, sessionId: string) {
        return trainingRepository.createSlot({
            startTime: start,
            endTime: end,
            isBooked: false,
            trainingSession: { connect: { id: sessionId } }
        });
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
