import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { PING_CONFIG } from "../config.js";
import logger from "../core/logger.js";

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

            if (isPrivate) {
                // Private chat reminder
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

            // 4. Build keyboard for ping (Apple HIG: Contextual actions)
            const kb = new InlineKeyboard();
            const isPreferences = msg.broadcast?.messageText?.includes("Побажання");

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
                    logger.warn(`🚫 Bot blocked or chat not found for ${msg.chatId}. Stopping pinger for this message.`);
                    await trackedMessageRepository.stopTracking(msg.id);
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
