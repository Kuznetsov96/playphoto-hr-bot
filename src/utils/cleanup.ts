import type { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { sessionRepository } from "../repositories/session-repository.js";

/**
 * 🧹 Efficiently deletes messages stored in the session.
 * Uses Promise.allSettled to avoid blocking and handle individual failures gracefully.
 */
export async function cleanupMessages(ctx: MyContext) {
    const toDelete = ctx.session.messagesToDelete;
    if (!toDelete || toDelete.length === 0) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Clear session immediately to prevent double-processing
    ctx.session.messagesToDelete = [];

    // Delete in parallel
    await Promise.allSettled(
        toDelete.map(msgId => ctx.api.deleteMessage(chatId, msgId).catch(() => {}))
    );
}

/**
 * 🧹 Видаляє повідомлення іншого користувача по його Telegram ID,
 * зчитуючи дані з бази даних (сесії).
 */
export async function cleanupUserSessionMessages(bot: Bot<any>, telegramId: number) {
    try {
        const key = String(telegramId);
        const sessionRecord = await sessionRepository.findByKey(key);
        if (!sessionRecord) return;

        let session;
        try {
            session = JSON.parse(sessionRecord.value);
        } catch (e) {
            return;
        }

        if (!session.messagesToDelete || session.messagesToDelete.length === 0) return;

        console.log(`🧹 [CLEANUP-EXT] Deleting ${session.messagesToDelete.length} messages for target user ${telegramId}`);

        // Delete in parallel to be faster
        await Promise.allSettled(
            session.messagesToDelete.map((msgId: number) => bot.api.deleteMessage(telegramId, msgId).catch(() => { }))
        );

        session.messagesToDelete = [];
        await sessionRepository.update(key, JSON.stringify(session));
    } catch (e) {
        console.error("❌ [CLEANUP-EXT] Error:", e);
    }
}

/**
 * 📝 Додає ID повідомлення до списку на видалення для ІНШОГО користувача.
 * Використовує upsert для надійності.
 */
export async function trackUserMessage(telegramId: number, messageId: number) {
    try {
        const key = String(telegramId);
        const sessionRecord = await sessionRepository.findByKey(key);
        
        let session: any = {};
        if (sessionRecord) {
            try {
                session = JSON.parse(sessionRecord.value);
            } catch (e) {
                session = {};
            }
        }

        if (!session.messagesToDelete) session.messagesToDelete = [];
        session.messagesToDelete.push(messageId);

        await sessionRepository.upsert(key, JSON.stringify(session));
    } catch (e) {
        console.error("❌ [TRACK-EXT] Error:", e);
    }
}

/**
 * 📝 Додає ID повідомлення до списку на видалення.
 */
export function trackMessage(ctx: MyContext, messageId: number) {
    if (!ctx.session.messagesToDelete) ctx.session.messagesToDelete = [];
    ctx.session.messagesToDelete.push(messageId);
}
