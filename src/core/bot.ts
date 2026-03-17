import { Bot } from "grammy";
import { redis } from "./redis.js";
import { lazySession } from "./session.js";
import { BOT_TOKEN } from "../config.js";
import { createRateLimitMiddleware } from "../middleware/rate-limit.js";
import { chatLoggerMiddleware, chatLogTransformer } from "../middleware/chat-logger.js";
import { autoRetry } from "@grammyjs/auto-retry";
import { sequentialize } from "@grammyjs/runner";

import logger from "./logger.js";
import { di } from "./container.js";
import { accessService } from "../services/access-service.js";

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
bot.api.config.use(chatLogTransformer);

// --- SESSION ---
bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
bot.use(lazySession());

// --- MIDDLEWARE ---

// 1. Raw update logging
bot.use(async (ctx, next) => {
    // Inject DI container cradle
    (ctx as any).di = di.cradle;
    
    const updateId = ctx.update.update_id;
    const fromId = ctx.from?.id;

    const logData = {
        updateId,
        from: fromId,
        chat: ctx.chat?.id,
        type: Object.keys(ctx.update).filter(k => k !== "update_id")[0],
        payload: ctx.message?.text || ctx.callbackQuery?.data,
    };
    logger.info(logData, `📡 [RAW] Update #${updateId} arrived`);

    await next();
});

// 2. Rate Limiting (Using resolver function to break circular cycles and avoid eager DI resolution)
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
    
    await next();
});

// 4. User Info Sync (Apple Style: proactive data integrity)
bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && !from.is_bot) {
        try {
            const telegramId = BigInt(from.id);
            const { userRepository } = di.cradle;
            const user = await userRepository.findByTelegramId(telegramId);
            
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

// 6. Global Command Breakout
bot.use(async (ctx, next) => {
    if (ctx.hasCommand("start")) {
        if (ctx.session) {
            ctx.session.step = "idle";
        }
    }
    await next();
});

// 7. Global Error Handler
bot.catch(async (err) => {
    const ctx = err.ctx;
    const error = err.error as any;
    const errMsg = (error?.message || String(err.error)).toLowerCase();
    const errDesc = (error?.description || "").toLowerCase();

    if (
        errMsg.includes("message is not modified") || 
        errDesc.includes("message is not modified") ||
        errMsg.includes("message to edit not found") ||
        errDesc.includes("message to edit not found") ||
        errMsg.includes("query is too old") ||
        errDesc.includes("query is too old") ||
        errMsg.includes("message identifier is not specified")
    ) {
        return;
    }

    logger.error({ 
        err: err.error, 
        updateId: ctx.update.update_id,
        userId: ctx.from?.id 
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
