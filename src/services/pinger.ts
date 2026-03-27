import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { CandidateStatus } from "@prisma/client";
import { PING_CONFIG, ADMIN_IDS, HR_IDS } from "../config.js";
import { scheduleSyncService } from "./schedule-sync.js";
import logger from "../core/logger.js";

const ACTIVE_CANDIDATE_STATUSES: CandidateStatus[] = [
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.READY_FOR_HIRE,
];

async function handleBlockedUser(bot: Bot<MyContext>, telegramId: number) {
    try {
        const userWithProfile = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));
        if (!userWithProfile) return;

        const staff = userWithProfile.staffProfile;
        const candidate = userWithProfile.candidate;

        // --- Staff ---
        if (staff?.isActive) {
            const staffName = staff.surnameNameDot || staff.fullName;
            logger.warn({ telegramId, staffName }, "🚫 [BLOCKED] Staff blocked the bot. Auto-deactivating...");

            await staffRepository.update(staff.id, { isActive: false });
            await scheduleSyncService.markStaffBotBlocked(telegramId);

            const adminId = ADMIN_IDS[0];
            if (adminId) {
                const text = `🚫 <b>Staff Bot Blocked</b>\n\n` +
                    `👤 <b>${staffName}</b> заблокувала бот.\n\n` +
                    `Виконано автоматично:\n` +
                    `• Статус → <b>Закінчення роботи</b>\n` +
                    `• Доступ до каналу — знято\n` +
                    `• Таблиця персоналу — оновлено`;
                await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" }).catch(() => {});
            }
            return;
        }

        // --- Candidate ---
        if (candidate && ACTIVE_CANDIDATE_STATUSES.includes(candidate.status as CandidateStatus)) {
            const name = candidate.fullName || "Candidate";
            logger.warn({ telegramId, name }, "🚫 [BLOCKED] Candidate blocked the bot. Auto-rejecting...");

            await candidateRepository.update(candidate.id, {
                status: CandidateStatus.REJECTED,
                candidateDecision: "Бот заблоковано / акаунт видалено"
            });

            const hrId = HR_IDS[0];
            if (hrId) {
                const text = `⚠️ <b>Bot Blocked</b>\n\n` +
                    `👤 <b>${name}</b> заблокувала бот.\n` +
                    `Статус → <b>REJECTED</b> автоматично.`;
                const kb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidate.id}`);
                await bot.api.sendMessage(hrId, text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
            }
            return;
        }

        logger.warn({ telegramId }, "🚫 Bot blocked — user is not active staff or active candidate. Skipping.");
    } catch (e) {
        logger.error({ err: e, telegramId }, "❌ [BLOCKED] handleBlockedUser failed");
    }
}

export function startPingerLoop(bot: Bot<MyContext>) {
    logger.info("🔔 Pinger loop started...");
    setInterval(() => runPinger(bot), PING_CONFIG.CHECK_INTERVAL_MS);
}

async function runPinger(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        const messagesToPing = await trackedMessageRepository.findToPing(now);

        for (const msg of messagesToPing) {
            // 1. If no pending replies, stop pinging
            if (msg.pendingReplies.length === 0) {
                await trackedMessageRepository.stopTracking(msg.id);
                logger.info(`✅ All replies received for message ${msg.messageId} in chat ${msg.chatId}. Tracking stopped.`);

                // Try to delete last ping if exists
                if (msg.lastPingMsgId) {
                    try {
                        await bot.api.deleteMessage(Number(msg.chatId), msg.lastPingMsgId);
                    } catch (e) { /* ignore */ }
                }
                continue;
            }

            // 2. Format ping message
            let text = "";
            const isPrivate = Number(msg.chatId) > 0;
            const isPreferences = msg.broadcast?.messageText?.includes("Побажання");

            if (isPrivate && isPreferences) {
                text = `🔔 <b>Нагадування!</b>\nТи ще не заповнив побажання по графіку. Натисни кнопку нижче 👇`;
            } else if (isPrivate) {
                text = `🔔 <b>Нагадування!</b>\nБудь ласка, натисніть кнопку "Підтвердити" у повідомленні вище 👆`;
            } else {
                // Group chat reminder with mentions
                const mentions = msg.pendingReplies.map(p => {
                    const user = p.user;
                    if (user.username) return `@${user.username}`;
                    return `<a href="tg://user?id=${user.telegramId}">${user.firstName || 'User'}</a>`;
                }).join(", ");

                text = `🔔 <b>Нагадування!</b>\nПрохання підтвердити ознайомлення з повідомленням вище 👆\n\nНе відповіли: ${mentions}`;
            }

            // 3. Delete old ping
            if (msg.lastPingMsgId) {
                try {
                    await bot.api.deleteMessage(Number(msg.chatId), msg.lastPingMsgId);
                } catch (e) {
                    logger.warn(`Failed to delete old ping in ${msg.chatId}: ${e}`);
                }
            }

            // 4. Build keyboard for ping
            const kb = new InlineKeyboard();

            if (isPreferences) {
                kb.text("🗓 Заповнити зараз", "pref_fill");
            } else {
                kb.text("✅ Ознайомлена", `broadcast_confirm_ok_${msg.broadcastId}`);
            }

            // 5. Send new ping
            try {
                const sentPing = await bot.api.sendMessage(Number(msg.chatId), text, {
                    reply_to_message_id: msg.messageId,
                    parse_mode: "HTML",
                    reply_markup: kb
                });

                // 6. Update tracking info
                const nextPingInterval = msg.pingIntervalMs || PING_CONFIG.REPEAT_DELAY_MS;
                await trackedMessageRepository.update(msg.id, {
                    lastPingMsgId: sentPing.message_id,
                    nextPingAt: new Date(Date.now() + nextPingInterval)
                });

                logger.info(`🔔 Ping sent to ${msg.chatId} for ${msg.pendingReplies.length} users.`);
            } catch (e: any) {
                if (e.error_code === 403 || (e.error_code === 400 && e.description?.includes("chat not found"))) {
                    await trackedMessageRepository.stopTracking(msg.id);
                    // Only treat as intentional block if we already pinged at least once before
                    // (msg.lastPingMsgId exists = at least one prior ping was delivered)
                    const chatId = Number(msg.chatId);
                    if (chatId > 0 && msg.lastPingMsgId) {
                        await handleBlockedUser(bot, chatId);
                    } else {
                        logger.warn(`🚫 Bot blocked or chat not found for ${msg.chatId}. Tracking stopped.`);
                    }
                } else if (e.error_code === 400 && e.description?.includes("message to be replied not found")) {
                    logger.warn(`⚠️ Original message not found in ${msg.chatId}. Stopping pinger.`);
                    await trackedMessageRepository.stopTracking(msg.id);
                } else {
                    logger.error({ err: e, chatId: msg.chatId }, "❌ Failed to send ping");
                }
            }
        }
    } catch (e) {
        logger.error({ err: e }, "❌ Error in Pinger Loop");
    }
}
