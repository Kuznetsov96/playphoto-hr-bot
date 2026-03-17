import type { MyContext } from "../types/context.js";
import type { NextFunction } from "grammy";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";

/**
 * Global middleware to block unauthorized users (Silent Block)
 */
export async function blockShield(ctx: MyContext, next: NextFunction) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return await next();

    try {
        const user = await userRepository.findByTelegramId(BigInt(telegramId)) as any;
        
        if (user?.isBlocked) {
            // Apple-style: Neutral "Service Unavailable" message
            const neutralMessage = "<b>System Maintenance</b>\nThis service is currently unavailable. Please try again later.";
            
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery({ text: "Service Unavailable", show_alert: true });
            } else if (ctx.chat?.type === "private") {
                await ctx.reply(neutralMessage, { parse_mode: "HTML" });
            }
            
            logger.info({ telegramId, username: ctx.from?.username }, "🛡️ [SHIELD] Blocked user attempt");
            return; // STOP processing
        }
    } catch (e) {
        logger.error({ err: e, telegramId }, "Error in blockShield middleware");
    }

    await next();
}
