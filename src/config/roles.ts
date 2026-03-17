
import type { AdminRole } from "@prisma/client";
import * as CONFIG from "../config.js";

/**
 * Permission definitions for each feature
 */
export const PERMISSIONS = {
    // Commands
    ADMIN_MENU: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    HR_MENU: ['SUPER_ADMIN', 'HR_LEAD'] as const,
    MENTOR_MENU: ['SUPER_ADMIN', 'MENTOR_LEAD'] as const,

    // Finance
    FINANCE_AUDIT: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    FINANCE_SYNC: ['SUPER_ADMIN', 'CO_FOUNDER'] as const,
    FINANCE_REPORTS: ['SUPER_ADMIN', 'CO_FOUNDER'] as const,

    // Staff Management
    STAFF_SYNC: ['SUPER_ADMIN'] as const,
    STAFF_SEARCH: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    STAFF_SCHEDULE: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    STAFF_VACATION: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    STAFF_TASKS: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,

    // Support
    SUPPORT_CHAT: ['SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'] as const,
    LOGISTICS_MENU: ['SUPPORT'] as const,

    // HR
    HR_CANDIDATES: ['SUPER_ADMIN', 'HR_LEAD'] as const,
    HR_INTERVIEWS: ['SUPER_ADMIN', 'HR_LEAD'] as const,

    // Mentor
    MENTOR_TRAINING: ['SUPER_ADMIN', 'MENTOR_LEAD'] as const,
    MENTOR_ONBOARDING: ['SUPER_ADMIN', 'MENTOR_LEAD'] as const,
} as const;

/**
 * Get admin role by Telegram ID
 */
export function getAdminRoleByTelegramId(telegramId: bigint): AdminRole | null {
    const id = Number(telegramId);
    if (CONFIG.ADMIN_IDS.includes(id)) return 'SUPER_ADMIN';
    if (CONFIG.CO_FOUNDER_IDS.includes(id)) return 'CO_FOUNDER';
    if (CONFIG.SUPPORT_IDS.includes(id)) return 'SUPPORT';
    if (CONFIG.HR_IDS.includes(id)) return 'HR_LEAD';
    if (CONFIG.MENTOR_IDS.includes(id)) return 'MENTOR_LEAD';
    return null;
}

/**
 * Check if user has required permission
 */
export function hasPermission(
    userRole: AdminRole | null | undefined,
    permission: keyof typeof PERMISSIONS
): boolean {
    if (!userRole) return false;
    return (PERMISSIONS[permission] as readonly string[]).includes(userRole);
}

/**
 * Check if user has any of the required roles
 */
export function hasAnyRole(
    userRole: AdminRole | null | undefined,
    ...roles: AdminRole[]
): boolean {
    if (!userRole) return false;
    return roles.includes(userRole);
}
