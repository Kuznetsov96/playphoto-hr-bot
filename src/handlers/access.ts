import { Composer } from "grammy";
import type { ChatMemberUpdated } from "grammy/types";
import { accessService } from "../services/access-service.js";
import { TEAM_CHATS } from "../config.js";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { securityAudit } from "../core/audit-logger.js";
import { knownChatRepository } from "../repositories/known-chat-repository.js";

export const accessHandlers = new Composer<MyContext>();

// Handle join requests if the channel is private with join requests enabled
accessHandlers.on("chat_join_request", async (ctx) => {
    const telegramId = BigInt(ctx.from.id);
    const chatId = ctx.chat.id;

    // Check if this is our team channel
    if (chatId !== TEAM_CHATS.CHANNEL) return;

    try {
        const authorized = await accessService.isAuthorized(telegramId);

        if (authorized) {
            securityAudit({
                event: "security.channel_join_request",
                result: "success",
                actorType: "candidate",
                telegramId,
                entityType: "channel_access",
                context: { chatId, action: "approve" }
            });
            await ctx.approveChatJoinRequest(ctx.from.id);
        } else {
            securityAudit({
                event: "security.channel_join_request",
                result: "failed",
                actorType: "candidate",
                telegramId,
                entityType: "channel_access",
                context: { chatId, action: "decline" }
            });
            await ctx.declineChatJoinRequest(ctx.from.id);
        }
    } catch (e) {
        logger.error({ err: e, telegramId: ctx.from.id, chatId }, "Channel join request handling failed");
    }
});

// Optional: Log when someone joins the channel via invite link
accessHandlers.on("chat_member", async (ctx) => {
    const chatId = ctx.chat.id;
    if (chatId !== TEAM_CHATS.CHANNEL) return;

    const newMember = ctx.chatMember.new_chat_member;
    const telegramId = BigInt(newMember.user.id);

    if (newMember.status === "member") {
        securityAudit({
            event: "security.channel_joined",
            result: "success",
            actorType: "candidate",
            telegramId,
            entityType: "channel_access",
            context: { chatId }
        });
        // Double check if they are authorized, if not - kick
        await accessService.syncUserAccess(telegramId);
    }
});

/**
 * Бот узнаёт о своих чатах от Telegram, а не из списка, который кто-то ведёт.
 *
 * Подписка на `my_chat_member` была здесь и раньше (`main.ts`), но обработчика
 * не существовало — событие приходило и терялось. Ровно поэтому чаты локаций
 * никогда не попадали в отзыв доступов.
 *
 * Приватные чаты не записываются: это переписка с одним человеком, а не
 * командный чат, и выгонять оттуда некого.
 */
export async function handleMyChatMember(update: ChatMemberUpdated): Promise<void> {
    const { chat, new_chat_member: newMember } = update;

    if (chat.type === "private") return;

    const isPresent = newMember.status !== "left" && newMember.status !== "kicked";

    try {
        if (isPresent) {
            await knownChatRepository.recordPresent({
                id: BigInt(chat.id),
                title: chat.title ?? null,
                type: chat.type
            });
        } else {
            await knownChatRepository.recordLost(BigInt(chat.id));
        }
    } catch (e) {
        logger.error({ err: e, chatId: chat.id }, "Failed to update known chat registry");
    }
}

accessHandlers.on("my_chat_member", async (ctx) => {
    await handleMyChatMember(ctx.myChatMember);
});
