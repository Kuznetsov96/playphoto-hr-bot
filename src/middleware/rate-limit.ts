import { limit } from "@grammyjs/ratelimiter";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { 
    ADMIN_IDS, MENTOR_IDS, SUPPORT_IDS, HR_IDS, 
    CO_FOUNDER_IDS, FINANCE_IDS, TEAM_CHATS 
} from "../config.js";

let candidateLimit: any = null;
let staffLimit: any = null;
let adminLimit: any = null;

async function notifyRateLimit(ctx: MyContext, text: string): Promise<void> {
    try {
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({ text, show_alert: true });
        } else {
            await ctx.reply(text);
        }
    } catch (error) {
        logger.debug({ err: error, telegramId: ctx.from?.id }, "Failed to show rate-limit notification");
    }
}

function getCandidateRateLimit(redis: any) {
    if (!candidateLimit) {
        candidateLimit = limit<MyContext, any>({
            timeFrame: 60 * 1000,
            limit: 20,
            storageClient: redis,
            keyGenerator: (ctx) => ctx.from?.id.toString(),
            onLimitExceeded: async (ctx) => {
                logger.warn(`⚠️ [LIMIT] Candidate ${ctx.from?.id} exceeded limit`);
                await notifyRateLimit(ctx, "🧘‍♀️ Ви виконуєте дії занадто часто. Будь ласка, зачекайте хвилинку. ✨");
            }
        });
    }
    return candidateLimit;
}

function getStaffRateLimit(redis: any) {
    if (!staffLimit) {
        staffLimit = limit<MyContext, any>({
            timeFrame: 60 * 1000,
            limit: 90,
            storageClient: redis,
            keyGenerator: (ctx) => `staff:${ctx.from?.id.toString()}`,
            onLimitExceeded: async (ctx) => {
                logger.warn(`⚠️ [LIMIT] Staff ${ctx.from?.id} exceeded limit`);
                await notifyRateLimit(ctx, "⚠️ Забагато дій за короткий час. Зачекай кілька секунд і спробуй ще раз.");
            }
        });
    }
    return staffLimit;
}

function getAdminRateLimit(redis: any) {
    if (!adminLimit) {
        adminLimit = limit<MyContext, any>({
            timeFrame: 60 * 1000,
            limit: 180,
            storageClient: redis,
            keyGenerator: (ctx) => `admin:${ctx.from?.id.toString()}`,
            onLimitExceeded: async (ctx) => {
                logger.warn(`⚠️ [LIMIT] Admin ${ctx.from?.id} exceeded limit`);
                await notifyRateLimit(ctx, "Too many actions. Slow down a bit.");
            }
        });
    }
    return adminLimit;
}

/**
 * Global router middleware factory to apply specific limits based on user role.
 * Taking dependencies as arguments to break circular cycles with DI container.
 */
export function createRateLimitMiddleware(redis: any, userRepositoryResolver: () => any) {
    return async (ctx: MyContext, next: () => Promise<void>) => {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId) return next();

        // Keep system chat traffic available, but still protect privileged users from floods in DMs.
        if (chatId) {
            const systemChatIds = Object.values(TEAM_CHATS);
            if (systemChatIds.includes(chatId)) {
                return getAdminRateLimit(redis)(ctx, next);
            }
        }

        // Apply a higher limit for privileged roles instead of a full bypass.
        if (
            ADMIN_IDS.includes(userId) ||
            CO_FOUNDER_IDS.includes(userId)
        ) {
            return getAdminRateLimit(redis)(ctx, next);
        }

        if (
            MENTOR_IDS.includes(userId) ||
            SUPPORT_IDS.includes(userId) ||
            HR_IDS.includes(userId) ||
            FINANCE_IDS.includes(userId)
        ) {
            return getStaffRateLimit(redis)(ctx, next);
        }

        // Defer resolution of userRepository until middleware is executed
        const userRepository = userRepositoryResolver();
        // Check if user is staff
        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(userId));

        if (user?.staffProfile?.isActive) {
            return getStaffRateLimit(redis)(ctx, next);
        }

        // Default to candidate limit
        return getCandidateRateLimit(redis)(ctx, next);
    };
}
