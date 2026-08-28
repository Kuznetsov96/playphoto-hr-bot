import { Bot } from "grammy";
import { redis } from "./redis.js";
import { lazySession } from "./session.js";
import { BOT_TOKEN } from "../config.js";
import { createRateLimitMiddleware } from "../middleware/rate-limit.js";
import { chatLoggerMiddleware, chatLogTransformer } from "../middleware/chat-logger.js";
import { recruitingIncomingMiddleware } from "../middleware/recruiting-incoming.js";
import { richMessageInputMiddleware } from "../middleware/rich-message.js";
import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";

import logger from "./logger.js";
import { di } from "./container.js";
import { accessService } from "../services/access-service.js";
import { sanitizeCallbackData } from "./log-sanitizer.js";

import type { MyContext } from "../types/context.js";

if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not defined in .env");
}

export const bot = new Bot<MyContext>(BOT_TOKEN);

// --- INITIALIZE SERVICES ---
// Inject bot API into access service to break circular dependency
accessService.setApi(bot.api);

// --- API TRANSFORMERS ---
bot.api.config.use(autoRetry());
// Keep outgoing sendMessage/editMessageText classic; rich output is explicit.
bot.api.config.use(chatLogTransformer);

// --- SESSION ---
bot.use(sequentialize((ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (userId !== undefined && chatId !== undefined) {
        return `${chatId}:${userId}`;
    }

    return (chatId ?? userId)?.toString() ?? "global";
}));
bot.use(lazySession());

// --- MIDDLEWARE ---

// 1. Raw update logging
bot.use(async (ctx, next) => {
    // Inject DI container cradle
    (ctx as any).di = di.cradle;
    
    const updateId = ctx.update.update_id;
    const fromId = ctx.from?.id;
    const correlationId = `tg-${updateId}`;
    ctx.correlationId = correlationId;
    const updateType = Object.keys(ctx.update).find(k => k !== "update_id") || "unknown";
    const callbackAction = sanitizeCallbackData(ctx.callbackQuery?.data);

    logger.info({
        event: "telegram.update.received",
        correlation_id: correlationId,
        update_id: updateId,
        update_type: updateType,
        telegram_id: fromId != null ? String(fromId) : undefined,
        chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : undefined,
        chat_type: ctx.chat?.type,
        callback_action: callbackAction,
        has_text: Boolean(ctx.message?.text),
        has_rich_message: Boolean(ctx.message?.rich_message),
        has_media: Boolean(ctx.message?.photo || ctx.message?.document || ctx.message?.video || ctx.message?.voice),
    });

    const startedAt = Date.now();
    try {
        await next();
    } finally {
        const durationMs = Date.now() - startedAt;
        const level = durationMs > 3000 ? "warn" : "info";
        logger[level]({
            event: "telegram.update.completed",
            correlation_id: correlationId,
            update_id: updateId,
            update_type: updateType,
            duration_ms: durationMs,
        });
    }
});

// 2. Load DB user once per update; downstream middleware reads ctx.dbUser instead of re-querying.
bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
        try {
            ctx.dbUser = await di.cradle.userRepository.findWithStaffProfileByTelegramId(BigInt(ctx.from.id));
        } catch (e) {
            logger.error({ err: e, telegramId: ctx.from.id }, "Failed to load user for update");
            ctx.dbUser = null;
        }
    } else {
        ctx.dbUser = null;
    }
    await next();
});

// 3. Rate Limiting (Using resolver function to break circular cycles and avoid eager DI resolution)
bot.use(createRateLimitMiddleware(redis, () => di.cradle.userRepository));

// 3. Global Context Initialization
bot.use(async (ctx, next) => {
    if (!ctx.session) {
        // This should not happen with lazySession but good for type safety
        (ctx as any).session = {};
    }
    
    // Initialize standard SMI structures if missing
    if (!ctx.session.navStack) ctx.session.navStack = [];
    if (!ctx.session.messagesToDelete) ctx.session.messagesToDelete = [];
    if (!ctx.session.candidateData) ctx.session.candidateData = {};
    if (!ctx.session.supportData) ctx.session.supportData = {};
    if (!ctx.session.step) ctx.session.step = "idle";
    if (!ctx.session.selectedCandidateId) ctx.session.selectedCandidateId = undefined;
    
    await next();
});

// 4. User Info Sync (Apple Style: proactive data integrity)
bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && !from.is_bot) {
        try {
            const { userRepository } = di.cradle;
            const user = ctx.dbUser;

            if (user) {
                const currentUsername = from.username || null;
                const currentFirstName = from.first_name || null;
                const currentLastName = from.last_name || null;

                const hasChanges = 
                    user.username !== currentUsername || 
                    user.firstName !== currentFirstName || 
                    user.lastName !== currentLastName;

                if (hasChanges) {
                    logger.debug({ telegramId: from.id, old: user.username, new: currentUsername }, "👤 [SYNC] Updating user info from Telegram");
                    await userRepository.update(user.id, {
                        username: currentUsername,
                        firstName: currentFirstName,
                        lastName: currentLastName
                    });
                    user.username = currentUsername;
                    user.firstName = currentFirstName;
                    user.lastName = currentLastName;
                }
            }
        } catch (e) {
            logger.error({ err: e }, "Failed to sync user info");
        }
    }
    await next();
});

// 5. Chat Logging
bot.use(chatLoggerMiddleware);

// 5.1. Зеркалирование входящих сообщений кандидаток в вебапп (фаза 3b).
// Fire-and-forget: недоступный вебапп не влияет на обработку апдейта.
bot.use(recruitingIncomingMiddleware);

// 6. Normalize rich-message text before all role/conversation handlers.
bot.use(richMessageInputMiddleware);

// 7. Global Command Breakout
bot.use(async (ctx, next) => {
    if (ctx.hasCommand("start")) {
        if (ctx.session) {
            ctx.session.step = "idle";
            delete ctx.session.adminFlow;
            delete ctx.session.taskData;
            delete ctx.session.taskCreation;
            delete ctx.session.broadcastData;
            delete ctx.session.broadcastDraft;
            delete ctx.session.manualChannelAccess;
            delete ctx.session.customSyncPromptMessageId;
            delete ctx.session.broadcastId;
            delete ctx.session.supportData?.step;
            delete ctx.session.supportData?.replyingToUserId;
        }
    }
    await next();
});

// 8. Global Error Handler
bot.catch(async (err) => {
    const ctx = err.ctx;
    const error = err.error as any;
    const errMsg = (error?.message || String(err.error)).toLowerCase();
    const errDesc = (error?.description || "").toLowerCase();

    if (errMsg.includes("message is not modified") || errDesc.includes("message is not modified")) {
        logger.debug({ updateId: ctx.update.update_id }, "Ignored no-op Telegram message edit");
        return;
    }

    if (errMsg.includes("query is too old") || errDesc.includes("query is too old")) {
        logger.warn({ updateId: ctx.update.update_id, telegramId: ctx.from?.id }, "Telegram callback expired before it was answered");
        return;
    }

    if (
        errMsg.includes("message to edit not found") ||
        errDesc.includes("message to edit not found") ||
        errMsg.includes("message identifier is not specified")
    ) {
        logger.warn({ err: err.error, updateId: ctx.update.update_id }, "Telegram screen could not be updated");
        if (ctx.chat?.type === "private") {
            await ctx.reply("Цей екран уже застарів. Натисни /start, щоб відкрити актуальне меню. ✨").catch(() => {});
        }
        return;
    }

    logger.error({ 
        event: "telegram.update.failed",
        err: err.error,
        correlation_id: ctx.correlationId || `tg-${ctx.update.update_id}`,
        update_id: ctx.update.update_id,
        telegram_id: ctx.from?.id != null ? String(ctx.from.id) : undefined,
        chat_id: ctx.chat?.id != null ? String(ctx.chat.id) : undefined,
        update_type: Object.keys(ctx.update).find(k => k !== "update_id") || "unknown",
    }, `🔥 [CRITICAL] Error while handling update ${ctx.update.update_id}`);

    try {
        if (ctx.chat?.type === "private") {
            const fallbackMsg = "🐾 <b>Ой, щось пішло не так!</b>\n\nМої внутрішні системи трохи заплутались, але ми вже з цим працюємо.\n\nБудь ласка, натисни /start, щоб оновити меню і спробувати знову. ✨";
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery("Відбулася технічна помилка 🛠️").catch(() => {});
                await ctx.reply(fallbackMsg, { parse_mode: "HTML" }).catch(() => {});
            } else if (ctx.message) {
                await ctx.reply(fallbackMsg, { parse_mode: "HTML" }).catch(() => {});
            }
        }
    } catch (fallbackErr) {
        logger.error({ err: fallbackErr }, "Failed to send fallback error message");
    }
});
