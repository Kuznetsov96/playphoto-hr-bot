import type { NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { telegramBlocklist } from "../services/telegram-blocklist.js";
import { securityAudit } from "../core/audit-logger.js";

/**
 * Перший middleware: апдейти заблокованих Telegram ID відсікаються мовчки.
 * Відповідь лише на callback_query (знімає спінер), решті нічого. Тексту в аудит не кладемо.
 * Поки список не завантажено, кожен апдейт пробує завантажити; не вдалось — пропускаємо.
 */
export async function telegramBlocklistGate(ctx: MyContext, next: NextFunction): Promise<void> {
    const from = ctx.from;
    if (!from) return await next();

    if (!telegramBlocklist.isLoaded() && !(await telegramBlocklist.ensureLoaded())) {
        return await next();
    }

    if (!telegramBlocklist.has(from.id)) return await next();

    if (ctx.callbackQuery) {
        try {
            await ctx.answerCallbackQuery();
        } catch {
            // Застаріла кнопка чи збій Telegram: заблокованому однаково нічого не показуємо.
        }
    }

    const updateType = Object.keys(ctx.update).find(k => k !== "update_id") || "unknown";
    securityAudit({
        event: "security.blocked_user_attempt",
        result: "failed",
        actorType: "candidate",
        telegramId: from.id,
        entityType: "bot",
        context: { updateType },
    });
}
