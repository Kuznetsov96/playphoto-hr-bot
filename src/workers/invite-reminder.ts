import { PrismaClient, CandidateStatus } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

const prisma = new PrismaClient();

const TEXT_24H_PING = `⏳ <b>Привіт!</b>\n\nТвоє запрошення на співбесіду все ще актуальне, але вільні місця швидко закінчуються. Якщо ти не обереш час до кінця дня, ми будемо змушені передати твоє місце наступному кандидату в черзі. 🐾`;

const TEXT_48H_RESET = `🐾 На жаль, термін дії запрошення минув, і місце було передано іншому кандидату.\n\nМи перевели твою анкету назад до резерву. Ти автоматично отримаєш сповіщення, коли у нас знову з'являться відкриті вакансії! ✨`;

/**
 * Checks candidates invited to interview.
 * - 24 hours: sends ping message.
 * - 48 hours: resets them to waitlist.
 */
export async function processInviteReminders(bot: any) {
    logger.info("🔄 [WORKER] Starting invite reminder process...");

    try {
        const now = new Date();
        const pingThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
        const resetThreshold = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

        // We only care about candidates in SCREENING who have been notified but haven't booked
        const pendingCandidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.SCREENING,
                notificationSent: true,
                interviewInvitedAt: { not: null },
                interviewSlotId: null, // Haven't booked yet
            },
            include: { user: true }
        });

        for (const cand of pendingCandidates) {
            if (!cand.interviewInvitedAt) continue;
            
            const invitedTime = cand.interviewInvitedAt.getTime();

            // Check if older than 48 hours -> Reset
            if (invitedTime <= resetThreshold.getTime()) {
                logger.info({ candId: cand.id }, "🔄 [WORKER] 48h passed. Resetting candidate to WAITLIST.");
                
                await prisma.candidate.update({
                    where: { id: cand.id },
                    data: {
                        status: CandidateStatus.WAITLIST,
                        isWaitlisted: true,
                        notificationSent: false, // Reset to allow future invites
                        interviewInvitedAt: null, // Reset time
                    }
                });

                try {
                    await bot.api.sendMessage(Number(cand.user.telegramId), TEXT_48H_RESET, { parse_mode: "HTML" });
                } catch (e) {}
                
            } 
            // Check if older than 24 hours but NOT older than 48 hours -> Ping
            // To avoid spamming ping, we need a flag. Wait, we don't have a specific `pingSent` flag in DB.
            // But we can check if it's exactly between 24h and 25h, OR add a field.
            // Since we didn't add pingSent, let's use a "time window" trick. Worker runs hourly.
            else if (invitedTime <= pingThreshold.getTime() && invitedTime > pingThreshold.getTime() - 2 * 60 * 60 * 1000) {
                // If it's between 24 and 26 hours ago
                // To avoid sending multiple times, if worker runs hourly, this is safe if we mark it somehow.
                // However, without a flag, we might send it twice if the worker runs twice within the 2-hour window.
                // A safer way is to just send it if it hasn't been sent.
                
                // Let's use the time window: 24h to 24h 59m
                if (invitedTime <= pingThreshold.getTime() && invitedTime > pingThreshold.getTime() - 60 * 60 * 1000) {
                    logger.info({ candId: cand.id }, "🔄 [WORKER] 24h passed. Sending ping.");
                    try {
                        await bot.api.sendMessage(Number(cand.user.telegramId), TEXT_24H_PING, {
                            parse_mode: "HTML",
                            reply_markup: new InlineKeyboard()
                                .text(STAFF_TEXTS["hr-btn-choose-time"], "start_scheduling").row()
                                .text(STAFF_TEXTS["hr-btn-invite-decline"], "decline_invite")
                        });
                    } catch (e) {}
                }
            }
        }
        logger.info("✅ [WORKER] Invite reminder process finished.");
    } catch (e: any) {
        logger.error({ err: e }, "❌ [WORKER] Failed to process invite reminders.");
    }
}
