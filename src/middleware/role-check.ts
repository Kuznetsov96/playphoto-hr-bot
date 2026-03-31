import type { AdminRole } from "@prisma/client";
import type { MyContext } from "../types/context.js";
import type { NextFunction } from "grammy";
import { userRepository } from "../repositories/user-repository.js";
import { getAdminRoleByTelegramId, hasPermission, hasAnyRole } from "../config/roles.js";
import { securityAudit } from "../core/audit-logger.js";

/**
 * Middleware to check if user has required admin role
 */
export function requireRole(...roles: AdminRole[]) {
    return async (ctx: MyContext, next: NextFunction) => {
        const telegramId = ctx.from?.id;
        if (!telegramId) {
            securityAudit({ event: "security.access.denied", result: "failed", actorType: "system", entityType: "admin_feature", error: "telegram_id_missing" });
            await ctx.reply("❌ Не вдалося визначити користувача.");
            return;
        }

        // Get user from DB
        let user = await userRepository.findByTelegramId(BigInt(telegramId));
        const autoRole = getAdminRoleByTelegramId(BigInt(telegramId));

        // SYNC: If autoRole exists and differs from DB, update DB
        if (autoRole && (!user || user.adminRole !== autoRole)) {
            if (user) {
                await userRepository.update(user.id, { adminRole: autoRole });
                user.adminRole = autoRole;
            } else {
                const newUser = await userRepository.create({
                    telegramId: BigInt(telegramId),
                    username: ctx.from?.username ?? null,
                    firstName: ctx.from?.first_name || "Unknown",
                    lastName: ctx.from?.last_name ?? null,
                    adminRole: autoRole
                });
                // Update local user reference to proceed with checks
                (user as any) = newUser;
            }
        }

        // Check if user has adminRole set
        if (!user || !user.adminRole) {
            securityAudit({
                event: "security.access.denied",
                result: "failed",
                actorType: "staff",
                telegramId,
                entityType: "admin_feature",
                context: { requiredRoles: roles }
            });
            if (ctx.chat?.type === "private") {
                await ctx.reply("❌ У вас немає доступу до цієї функції.");
            }
            return;
        }

        // Check if user has required role
        if (!hasAnyRole(user.adminRole, ...roles)) {
            securityAudit({
                event: "security.access.denied",
                result: "failed",
                actorType: "staff",
                telegramId,
                role: user.adminRole,
                entityType: "admin_feature",
                context: { requiredRoles: roles }
            });
            if (ctx.callbackQuery) {
                await ctx.answerCallbackQuery({ text: "❌ No access to this function.", show_alert: true });
            } else if (ctx.chat?.type === "private") {
                await ctx.reply("❌ У вас немає доступу до цієї функції.");
            }
            return;
        }

        await next();
    };
}

/**
 * Middleware to check if user has required permission
 */
export function requirePermission(permission: Parameters<typeof hasPermission>[1]) {
    return async (ctx: MyContext, next: NextFunction) => {
        const telegramId = ctx.from?.id;
        if (!telegramId) {
            securityAudit({ event: "security.permission.denied", result: "failed", actorType: "system", entityType: "permission", error: "telegram_id_missing" });
            await ctx.reply("❌ Не вдалося визначити користувача.");
            return;
        }

        const user = await userRepository.findByTelegramId(BigInt(telegramId));

        // Try auto-assign if no role
        if (!user || !user.adminRole) {
            const autoRole = getAdminRoleByTelegramId(BigInt(telegramId));
            if (autoRole && user) {
                await userRepository.update(user.id, { adminRole: autoRole });
                if (hasPermission(autoRole, permission)) {
                    await next();
                    return;
                }
            }

            if (ctx.chat?.type === "private") {
                securityAudit({
                    event: "security.permission.denied",
                    result: "failed",
                    actorType: "staff",
                    telegramId,
                    entityType: "permission",
                    context: { permission }
                });
                await ctx.reply("❌ У вас немає доступу до цієї функції.");
            }
            return;
        }

        if (!hasPermission(user.adminRole, permission)) {
            securityAudit({
                event: "security.permission.denied",
                result: "failed",
                actorType: "staff",
                telegramId,
                role: user.adminRole,
                entityType: "permission",
                context: { permission }
            });
            if (ctx.chat?.type === "private") {
                await ctx.reply("❌ У вас немає доступу до цієї функції.");
            }
            return;
        }

        await next();
    };
}

/**
 * Get user's admin role (with auto-assignment if needed)
 */
export async function getUserAdminRole(telegramId: bigint): Promise<AdminRole | null> {
    const user = await userRepository.findByTelegramId(telegramId);

    // Check auto-assignment first if not in DB
    const autoRole = getAdminRoleByTelegramId(telegramId);

    if (!user) return autoRole;

    // Auto-assign or sync role if it differs from DB
    if (autoRole && user.adminRole !== autoRole) {
        await userRepository.update(user.id, { adminRole: autoRole });
        return autoRole;
    }

    return user.adminRole;
}
