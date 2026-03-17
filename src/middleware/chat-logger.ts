import type { Transformer } from "grammy";
import type { MyContext } from "../types/context.js";
import { chatLogRepository } from "../repositories/chat-log-repository.js";
import prisma from "../db/core.js";
import type { MiddlewareFn } from "grammy";

/**
 * Middleware: logs every incoming message/callback from users to ChatLog.
 */
export const chatLoggerMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
    // Only log private chats (user ↔ bot), skip groups
    if (ctx.chat?.type === "private" && ctx.from) {
        const telegramId = BigInt(ctx.from.id);

        // Resolve userId (fire-and-forget, don't block)
        const userPromise = prisma.user.findUnique({
            where: { telegramId },
            select: { id: true }
        }).catch(() => null);

        let contentType = "text";
        let text: string | null = null;
        let mediaFileId: string | null = null;

        if (ctx.callbackQuery?.data) {
            contentType = "callback";
            text = ctx.callbackQuery.data;
        } else if (ctx.message) {
            const msg = ctx.message;
            text = msg.text || msg.caption || null;

            if (msg.photo && msg.photo.length > 0) {
                contentType = "photo";
                mediaFileId = msg.photo[msg.photo.length - 1]!.file_id;
            } else if (msg.video) {
                contentType = "video";
                mediaFileId = msg.video.file_id;
            } else if (msg.document) {
                contentType = "document";
                mediaFileId = msg.document.file_id;
            } else if (msg.sticker) {
                contentType = "sticker";
                mediaFileId = msg.sticker.file_id;
            } else if (msg.voice) {
                contentType = "voice";
                mediaFileId = msg.voice.file_id;
            } else if (msg.video_note) {
                contentType = "video_note";
                mediaFileId = msg.video_note.file_id;
            } else if (msg.contact) {
                contentType = "contact";
                text = JSON.stringify({ phone: msg.contact.phone_number, name: msg.contact.first_name });
            } else if (msg.location) {
                contentType = "location";
                text = JSON.stringify({ lat: msg.location.latitude, lon: msg.location.longitude });
            }
        } else {
            // Not a message or callback — skip logging
            await next();
            return;
        }

        // Fire-and-forget: log without blocking the handler
        userPromise.then(user => {
            chatLogRepository.logIncoming(telegramId, contentType, text, mediaFileId, user?.id);
        });
    }

    await next();
};

/**
 * API Transformer: logs every outgoing sendMessage/editMessageText to ChatLog.
 * Attached via bot.api.config.use()
 */
export const chatLogTransformer: Transformer = async (prev, method, payload, signal) => {
    // We make it async to wait for the result and catch errors
    try {
        const result = await prev(method, payload, signal);

        // Only log message-sending methods to private chats
        if (method === "sendMessage" || method === "editMessageText") {
            const p = payload as any;
            const chatId = p?.chat_id;
            const text = p?.text ?? p?.caption ?? null;

            // Only log if chat_id looks like a user (positive number = private chat)
            if (chatId && Number(chatId) > 0) {
                const telegramId = BigInt(chatId);
                // Resolve userId and log (fire-and-forget)
                prisma.user.findUnique({
                    where: { telegramId },
                    select: { id: true }
                }).then(user => {
                    chatLogRepository.logOutgoing(telegramId, text, user?.id);
                }).catch(() => {});
            }
        }

        return result;
    } catch (error: any) {
        // LOG ERROR TO DATABASE
        if (method === "sendMessage" || method === "editMessageText") {
            const p = payload as any;
            const chatId = p?.chat_id;
            const text = p?.text ?? p?.caption ?? null;

            if (chatId && Number(chatId) > 0) {
                const telegramId = BigInt(chatId);
                const errorMessage = error.description || error.message || "Unknown API Error";
                
                prisma.user.findUnique({
                    where: { telegramId },
                    select: { id: true }
                }).then(user => {
                    chatLogRepository.logOutgoing(telegramId, text, user?.id, errorMessage);
                }).catch(() => {});
            }
        }
        
        throw error; // Rethrow to let grammy handle it
    }
};
