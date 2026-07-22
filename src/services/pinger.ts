import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { pendingReplyRepository } from "../repositories/pending-reply-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { CandidateStatus } from "@prisma/client";
import { PING_CONFIG, ADMIN_IDS, HR_IDS } from "../config.js";
import { scheduleSyncService } from "./schedule-sync.js";
import logger from "../core/logger.js";
import { logBusinessEvent, logSecurityEvent } from "../core/log-events.js";
import { handleBlockedCandidate } from "../utils/bot-blocked.js";
import { escapeHtml } from "../handlers/admin/utils.js";

// Only HR-stage statuses — pinger broadcast targets early funnel
const ACTIVE_CANDIDATE_STATUSES: CandidateStatus[] = [
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST,
    CandidateStatus.WAITLIST_HR,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
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
            logger.warn({ telegramId, staffId: staff.id }, "Staff blocked bot; auto-deactivation started");

            await staffRepository.update(staff.id, {
                isActive: false,
                deactivatedAt: new Date(),
                deactivatedBy: "system:pinger",
                deactivatedSource: "BOT_BLOCKED",
                deactivatedReason: "Telegram 403 bot blocked"
            } as any);
            await scheduleSyncService.markStaffBotBlocked(telegramId);
            logSecurityEvent({
                event: "security.staff.bot_blocked",
                telegramId,
                userId: userWithProfile.id,
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "pinger",
                operation: "handleBlockedUser",
                safeContext: {
                    staffId: staff.id,
                    staffName,
                    action: "auto_deactivated",
                },
            });

            const adminId = ADMIN_IDS[0];
            if (adminId) {
                const text = `🚫 <b>Staff Bot Blocked</b>\n\n` +
                    `👤 <b>${escapeHtml(staffName)}</b> blocked the bot.\n\n` +
                    `Automatic actions completed:\n` +
                    `• Status → <b>Offboarded</b>\n` +
                    `• Channel access — removed\n` +
                    `• Staff sheet — updated`;
                await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" }).catch(() => { });
            }
            return;
        }

        // --- Candidate ---
        if (candidate && ACTIVE_CANDIDATE_STATUSES.includes(candidate.status as CandidateStatus)) {
            const name = candidate.fullName || "Candidate";
            logger.warn({ telegramId, candidateId: candidate.id, stage: candidate.status }, "Candidate blocked bot; blocker archival started");

            await handleBlockedCandidate(bot.api, candidate.id, name);
            logSecurityEvent({
                event: "security.candidate.bot_blocked",
                telegramId,
                userId: userWithProfile.id,
                candidateId: candidate.id,
                actorType: "system",
                actorRole: "system",
                stage: candidate.status,
                result: "success",
                module: "pinger",
                operation: "handleBlockedUser",
                safeContext: {
                    candidateName: name,
                    action: "archived_as_blocker",
                },
            });
            return;
        }

        logger.warn({ telegramId }, "Bot blocked event ignored for inactive or unsupported user");
    } catch (e) {
        logger.error({ err: e, telegramId }, "Blocked user handler failed");
    }
}

function isActiveMembership(member: any): boolean {
    if (!member || !member.status) return false;
    if (member.status === "creator" || member.status === "administrator" || member.status === "member") return true;
    if (member.status === "restricted") return member.is_member !== false;
    return false;
}

async function pruneNonMembersFromPending(msg: any, bot: Bot<MyContext>) {
    const chatId = Number(msg.chatId);
    if (chatId > 0) return msg.pendingReplies;

    const stalePendingIds: number[] = [];
    const stillPending: typeof msg.pendingReplies = [];

    for (const reply of msg.pendingReplies) {
        try {
            const member = await bot.api.getChatMember(chatId, Number(reply.userId));
            if (isActiveMembership(member)) {
                stillPending.push(reply);
            } else {
                stalePendingIds.push(reply.id);
            }
        } catch (e: any) {
            const description = String(e?.description || "").toLowerCase();
            if (
                e?.error_code === 400 ||
                description.includes("user not found") ||
                description.includes("participant_id_invalid") ||
                description.includes("user not participant")
            ) {
                stalePendingIds.push(reply.id);
                continue;
            }
            // Keep the pending reply on transient API failures.
            stillPending.push(reply);
        }
    }

    if (stalePendingIds.length > 0) {
        await pendingReplyRepository.deleteMany({ id: { in: stalePendingIds } });
    }

    return stillPending;
}

export function startPingerLoop(bot: Bot<MyContext>) {
    logBusinessEvent({
        event: "broadcast.pinger_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "pinger",
        operation: "startPingerLoop",
        safeContext: {
            intervalMs: PING_CONFIG.CHECK_INTERVAL_MS,
        },
    });
    setInterval(() => runPinger(bot), PING_CONFIG.CHECK_INTERVAL_MS);
}

async function runPinger(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        const messagesToPing = await trackedMessageRepository.findToPing(now);

        for (const msg of messagesToPing) {
            const activePendingReplies = await pruneNonMembersFromPending(msg, bot);

            // 1. If no pending replies, stop pinging
            if (activePendingReplies.length === 0) {
                await trackedMessageRepository.stopTracking(msg.id);
                logBusinessEvent({
                    event: "broadcast.ping_tracking.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "pinger",
                    operation: "runPinger",
                    safeContext: {
                        trackedMessageId: msg.id,
                        chatId: msg.chatId,
                        messageId: msg.messageId,
                    },
                });

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
                const mentions = activePendingReplies.map((p: any) => {
                    const user = p.user;
                    if (user.username) return `@${escapeHtml(user.username)}`;
                    return `<a href="tg://user?id=${user.telegramId}">${escapeHtml(user.firstName || 'User')}</a>`;
                }).join(", ");

                text = `🔔 <b>Нагадування!</b>\nПрохання підтвердити ознайомлення з повідомленням вище 👆\n\nНе відповіли: ${mentions}`;
            }

            // 3. Delete old ping
            if (msg.lastPingMsgId) {
                try {
                    await bot.api.deleteMessage(Number(msg.chatId), msg.lastPingMsgId);
                } catch (e) {
                    logger.warn({ err: e, chatId: msg.chatId, trackedMessageId: msg.id }, "Previous ping deletion failed");
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

                logBusinessEvent({
                    event: "broadcast.ping_sent",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "pinger",
                    operation: "runPinger",
                    safeContext: {
                        trackedMessageId: msg.id,
                        chatId: msg.chatId,
                        messageId: msg.messageId,
                        pendingReplies: activePendingReplies.length,
                    },
                });
            } catch (e: any) {
                if (e.error_code === 403 || (e.error_code === 400 && e.description?.includes("chat not found"))) {
                    await trackedMessageRepository.stopTracking(msg.id);
                    // Only treat as intentional block if we already pinged at least once before
                    // (msg.lastPingMsgId exists = at least one prior ping was delivered)
                    const chatId = Number(msg.chatId);
                    if (chatId > 0 && msg.lastPingMsgId) {
                        await handleBlockedUser(bot, chatId);
                    } else {
                        logger.warn({ chatId: msg.chatId, trackedMessageId: msg.id }, "Ping tracking stopped because chat is blocked or missing");
                    }
                    logBusinessEvent({
                        event: "broadcast.ping_tracking.stopped",
                        level: "warn",
                        actorType: "system",
                        actorRole: "system",
                        result: "stopped",
                        reasonCode: "CHAT_BLOCKED_OR_NOT_FOUND",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                } else if (e.error_code === 400 && e.description?.includes("message to be replied not found")) {
                    logger.warn({ chatId: msg.chatId, trackedMessageId: msg.id, messageId: msg.messageId }, "Ping tracking stopped because original message was not found");
                    await trackedMessageRepository.stopTracking(msg.id);
                    logBusinessEvent({
                        event: "broadcast.ping_tracking.stopped",
                        level: "warn",
                        actorType: "system",
                        actorRole: "system",
                        result: "stopped",
                        reasonCode: "ORIGINAL_MESSAGE_NOT_FOUND",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                } else {
                    logger.error({ err: e, chatId: msg.chatId, trackedMessageId: msg.id }, "Ping delivery failed");
                    logBusinessEvent({
                        event: "broadcast.ping_sent",
                        level: "error",
                        actorType: "system",
                        actorRole: "system",
                        result: "failed",
                        reasonCode: "PING_SEND_FAILED",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                }
            }
        }
    } catch (e) {
        logger.error({ err: e }, "Pinger loop iteration failed");
        logBusinessEvent({
            event: "broadcast.pinger_loop.failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            module: "pinger",
            operation: "runPinger",
            error: e,
        });
    }
}
