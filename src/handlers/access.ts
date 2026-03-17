import { Composer } from "grammy";
import { accessService } from "../services/access-service.js";
import { TEAM_CHATS } from "../config.js";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";

export const accessHandlers = new Composer<MyContext>();

// Handle join requests if the channel is private with join requests enabled
accessHandlers.on("chat_join_request", async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const chatId = ctx.chat.id;

    // Check if this is our team channel
    if (chatId !== TEAM_CHATS.CHANNEL) return;

    logger.info({ telegramId: ctx.from.id, chatId }, "Received chat join request");

    try {
        const authorized = await accessService.isAuthorized(telegramId);

        if (authorized) {
            logger.info({ telegramId: ctx.from.id }, "Approving authorized join request");
            await ctx.approveChatJoinRequest(ctx.from.id);
        } else {
            logger.info({ telegramId: ctx.from.id }, "Declining unauthorized join request");
            await ctx.declineChatJoinRequest(ctx.from.id);
        }
    } catch (e) {
        logger.error({ err: e, telegramId: ctx.from.id }, "Error handling join request");
    }
});

// Optional: Log when someone joins the channel via invite link
accessHandlers.on("chat_member", async (ctx) => {
    const chatId = ctx.chat.id;
    if (chatId !== TEAM_CHATS.CHANNEL) return;

    const newMember = ctx.chatMember.new_chat_member;
    const telegramId = BigInt(newMember.user.id);

    if (newMember.status === "member") {
        logger.info({ telegramId: newMember.user.id }, "New member joined the team channel");
        // Double check if they are authorized, if not - kick
        await accessService.syncUserAccess(telegramId);
    }
});
