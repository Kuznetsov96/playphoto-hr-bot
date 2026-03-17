import { limit } from "@grammyjs/ratelimiter";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { 
    ADMIN_IDS, MENTOR_IDS, SUPPORT_IDS, HR_IDS, 
    CO_FOUNDER_IDS, FINANCE_IDS, TEAM_CHATS 
} from "../config.js";

let candidateLimit: any = null;

function getCandidateRateLimit(redis: any) {
    if (!candidateLimit) {
        candidateLimit = limit<MyContext, any>({
            timeFrame: 60 * 1000,
            limit: 20,
            storageClient: redis,
            keyGenerator: (ctx) => ctx.from?.id.toString(),
            onLimitExceeded: async (ctx) => {
                logger.warn(`⚠️ [LIMIT] Candidate ${ctx.from?.id} exceeded limit`);
                try {
                    await ctx.reply("🧘‍♀️ Ви надсилаєте повідомлення занадто часто. Будь ласка, зачекайте хвилинку. ✨");
                } catch (e) { }
            }
        });
    }
    return candidateLimit;
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

        // Bypass for System Team Chats (HUB, SUPPORT, CHANNEL)
        if (chatId) {
            const systemChatIds = Object.values(TEAM_CHATS);
            if (systemChatIds.includes(chatId)) {
                return next();
            }
        }

        // Bypass for Admins, Mentors, Support, HR, Co-Founders, and Finance
        if (
            ADMIN_IDS.includes(userId) ||
            MENTOR_IDS.includes(userId) ||
            SUPPORT_IDS.includes(userId) ||
            HR_IDS.includes(userId) ||
            CO_FOUNDER_IDS.includes(userId) ||
            FINANCE_IDS.includes(userId)
        ) {
            return next();
        }

        // Defer resolution of userRepository until middleware is executed
        const userRepository = userRepositoryResolver();
        // Check if user is staff
        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(userId));

        if (user?.staffProfile?.isActive) {
            return next();
        }

        // Default to candidate limit
        return getCandidateRateLimit(redis)(ctx, next);
    };
}
