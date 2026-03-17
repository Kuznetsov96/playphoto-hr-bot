import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";

/**
 * Check if user has finance permissions
 * Returns true if user has FINANCE_AUDIT permission
 */
export async function hasFinanceAccess(ctx: MyContext): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const userRole = await getUserAdminRole(BigInt(telegramId));
    return hasPermission(userRole, 'FINANCE_AUDIT');
}

/**
 * Check if user has staff sync permissions
 * Returns true if user has STAFF_SYNC permission
 */
export async function hasStaffSyncAccess(ctx: MyContext): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const userRole = await getUserAdminRole(BigInt(telegramId));
    return hasPermission(userRole, 'STAFF_SYNC');
}
