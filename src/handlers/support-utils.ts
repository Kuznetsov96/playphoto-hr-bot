import type { MyContext } from "../types/context.js";
import { supportRepository } from "../repositories/support-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { TEAM_CHATS } from "../config.js";
import logger from "../core/logger.js";
import { TicketStatus } from "@prisma/client";

export async function updateTicketVisuals(ctx: MyContext, ticketId: number) {
    const ticket = await supportRepository.findTicketById(ticketId);
    if (!ticket) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(ticket.user.telegramId));
    if (!user) return;

    // Update Topic Name
    if (ticket.topicId) {
        const { buildTopicTitle } = await import("../utils/ticket-card.js");
        let locationName = user.staffProfile?.location?.name || null;
        let locationCity = user.staffProfile?.location?.city || null;
        if (user.staffProfile) {
            const shift = await workShiftRepository.findClosestShiftWithLocation(user.staffProfile.id, new Date());
            if (shift?.location) {
                locationName = shift.location.name;
                locationCity = shift.location.city;
            }
        }
        const isClarification = ticket.issueText.includes("Уточнення по завданню");
        const adminRole = ticket.assignedAdmin?.adminRole || null;
        const newTitle = buildTopicTitle(ticketId, user.staffProfile?.fullName || "Невідомо", locationName, ticket.status as TicketStatus, ticket.isUrgent, isClarification, locationCity, ticket.assignedAdminId, adminRole);
        try {
            await ctx.api.editForumTopic(TEAM_CHATS.SUPPORT, ticket.topicId, { name: newTitle });
        } catch (e) {
            logger.warn({ err: e }, "Failed to update topic title");
        }
    }

    // Update Card Message
    // Requires context to have message (usually callback query)
    if (ctx.callbackQuery?.message) {
        const { buildTicketCard, getTicketButtons } = await import("../utils/ticket-card.js");
        const isClarification = ticket.issueText.includes("Уточнення по завданню");
        const cardText = await buildTicketCard(ticket, user, isClarification);
        const buttons = getTicketButtons(ticketId, ticket.status as TicketStatus);

        // Check if content actually changed to avoid API error
        try {
            await ctx.editMessageText(cardText, { parse_mode: "HTML", reply_markup: buttons });
        } catch (e: any) {
            if (!e.message.includes('message is not modified')) {
                logger.warn({ err: e }, "Failed to update ticket card");
            }
        }
    }
}

/**
 * Unified UI logic for closing any forum topic (Ticket or OutgoingTopic).
 * Handles: Renaming with ✖️, removing inline buttons, sending final notice, closing thread.
 */
export async function finalizeTopicUIClosure(ctx: MyContext, chatId: string | number, topicId: number, newTitle: string) {
    try {
        // 1. Remove buttons from the current message (if any)
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

        // 2. Rename Topic with ✖️
        // Ensure title starts with ✖️ if not already
        const finalTitle = newTitle.startsWith("✖️") ? newTitle : `✖️ ${newTitle}`;
        await ctx.api.editForumTopic(chatId, topicId, { name: finalTitle }).catch(err => {
            logger.warn({ err, topicId }, "Failed to rename forum topic");
        });

        // 3. Send final notice inside the topic
        const initiatorName = ctx.from?.first_name || "Admin";
        await ctx.api.sendMessage(chatId, `🔒 <b>Administrator closed this topic.</b>\n(Closed by ${initiatorName})`, {
            message_thread_id: topicId,
            parse_mode: "HTML"
        }).catch(() => {});

        // 4. Close the forum thread in Telegram UI
        await ctx.api.closeForumTopic(chatId, topicId).catch(err => {
            logger.warn({ err, topicId }, "Failed to close forum thread");
        });

        // 5. Answer callback with a simple checkmark
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery("Topic closed ✅").catch(() => {});
        }
    } catch (e: any) {
        logger.error({ err: e, topicId }, "Error during finalizeTopicUIClosure");
    }
}

/**
 * Sends a status message to the user, deleting the previous one if it exists.
 * Used for "Seamless Support Chat" experience.
 * 
 * @param ctx - Context (used for API access)
 * @param text - Message text
 * @param extra - Extra message options (keyboard, parse_mode)
 * @param targetChatId - Optional target chat ID (if different from ctx.chat.id, e.g. from Admin actions)
 */
export async function sendSupportStatus(ctx: MyContext, text: string, extra?: any, targetChatId?: number) {
    const chatId = targetChatId || ctx.chat?.id;
    if (!chatId) return;

    // Find User to get last message ID
    const user = await userRepository.findByTelegramId(BigInt(chatId));

    // Delete previous status message
    if (user && user.lastSupportMessageId) {
        try {
            await ctx.api.deleteMessage(chatId, user.lastSupportMessageId);
        } catch (e: any) {
            // Ignore if message not found or already deleted
            if (!e.description?.includes("message to delete not found")) {
                logger.warn({ err: e }, `Failed to delete last status message for user ${chatId}`);
            }
        }
    }

    // Send new status message
    try {
        const msg = await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });

        // Save new message ID to DB
        if (user) {
            // We need to update user. Repository update takes ID (uuid)
            await userRepository.update(user.id, { lastSupportMessageId: msg.message_id });
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to send support status");
    }
}
