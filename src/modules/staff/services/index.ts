import { staffRepository } from "../../../repositories/staff-repository.js";
import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { locationRepository } from "../../../repositories/location-repository.js";
import { supportRepository } from "../../../repositories/support-repository.js";
import { taskService } from "../../../services/task-service.js";
import logger from "../../../core/logger.js";
import type { StaffProfile } from "@prisma/client";
import { formatLocationName } from "../../../handlers/admin/utils.js";
import { shortenName } from "../../../utils/string-utils.js";
import type { AdminRole } from "@prisma/client";
import { CandidateStatus, Role } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import { candidateRepository } from "../../../repositories/candidate-repository.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { TEAM_CHANNEL_LINK } from "../../../config.js";

import { ADMIN_TEXTS } from "../../../constants/admin-texts.js";
import { STAFF_TEXTS } from "../../../constants/staff-texts.js";

const t = (key: string, args?: any) => {
    // @ts-ignore
    const text = ADMIN_TEXTS[key] || STAFF_TEXTS[key];
    if (typeof text === 'function') return text(args || {});
    return text || key;
};


export class StaffService {
    async getProfileText(profile: StaffProfile, isSelfView: boolean = true, viewerRole?: AdminRole | null) {
        const isEn = viewerRole === 'SUPER_ADMIN' || viewerRole === 'CO_FOUNDER' || viewerRole === 'SUPPORT';
        
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const shifts = await workShiftRepository.findWithLocationForStaff(profile.id, thirtyDaysAgo);

        const uniqueLocs = new Map<string, any>();
        // Primary location first if exists
        if (profile.locationId) {
            const primaryLoc = await locationRepository.findById(profile.locationId);
            if (primaryLoc) uniqueLocs.set(primaryLoc.id, primaryLoc);
        }
        // Add locations from shifts
        shifts.forEach(s => uniqueLocs.set(s.locationId, s.location));

        const locItems = Array.from(uniqueLocs.values()).map(l => formatLocationName(l.name, l.city));
        const locStr = locItems.length > 0 ? locItems.join(', ') : (isEn ? 'not assigned' : 'не призначено');

        let displayName = this.formatStaffName(profile.fullName);
        const username = (profile as any).user?.username;
        if (username) {
            displayName += ` (@${username})`;
        }

        const headerKey = isSelfView ? 'admin-profile-title-self' : 'admin-profile-title-other';
        const header = t(headerKey);
        let text = `${header}\n\n`;

        // Check for First Shift Marker (only for admin view)
        if (!isSelfView && viewerRole) {
            const earliestShift = await workShiftRepository.findEarliestShift(profile.id);
            if (earliestShift) {
                const today = new Date();
                const shiftDate = new Date(earliestShift.date);
                
                const isToday = today.getFullYear() === shiftDate.getFullYear() &&
                                today.getMonth() === shiftDate.getMonth() &&
                                today.getDate() === shiftDate.getDate();
                
                if (isToday) {
                    text += t('admin-profile-first-shift');
                }
            }
        }

        text += `<b>${t('admin-profile-name')}</b> ${displayName}\n`;
        text += `<b>${t('admin-profile-phone')}</b> ${profile.phone || t('admin-tasks-loc-unknown')}\n`;

        text += `<b>${t('admin-profile-locations')}</b> ${locStr}\n`;
        return text;
    }

    formatStaffName(fullName: string): string {
        return shortenName(fullName);
    }

    async getAdminHeader(role?: string) {
        try {
            if (role === 'SUPPORT') {
                const openTickets = await supportRepository.countByStatus("OPEN" as any).catch(() => 0);
                const inProgressTickets = await supportRepository.countByStatus("IN_PROGRESS" as any).catch(() => 0);
                const urgentTickets = await supportRepository.countUrgent().catch(() => 0);
                const overdueTasks = await taskService.countOverdueTasks(new Date()).catch(() => 0);

                return t('support-panel-title') + "\n\n" +
                    t('support-panel-tickets', { open: openTickets, inprogress: inProgressTickets }) + "\n" +
                    t('support-panel-urgent', { urgent: urgentTickets }) + "\n" +
                    t('support-panel-tasks', { overdue: overdueTasks }) + "\n\n" +
                    t('support-panel-action');
            }

            const activePhotographers = await staffRepository.countActive().catch(() => 0);
            const locations = await locationRepository.findAll().catch(() => []);

            return t('admin-panel-title') + "\n\n" +
                t('admin-panel-team', { active: activePhotographers }) + "\n" +
                t('admin-panel-locations', { active: locations.length }) + "\n\n" +
                t('admin-panel-category');
        } catch (e) {
            logger.error({ err: e }, "Failed to generate admin header");
            return "🔧 <b>Admin Panel</b>\n\nWelcome back! (System stats temporarily unavailable)";
        }
    }

    shortenName(fullName: string) {
        return shortenName(fullName);
    }

    async getInactiveStaffReport() {
        const inactive = await staffRepository.findInactiveWithUser();
        if (inactive.length === 0) return "All staff members are active! ✨";

        const list = inactive.map((p: any) => `• ${this.shortenName(p.fullName)}`).join('\n');
        return `<b>⚠️ INACTIVE STAFF:</b>\n\n${list}`;
    }

    async searchStaff(query: string) {
        return staffRepository.findByQuery(query);
    }

    /**
     * UNIFIED ACTIVATION: Sends the official welcome message and updates status.
     * This is the Single Source of Truth for hiring a new photographer.
     */
    async finalizeStaffActivation(staffId: string, api: any) {
        const staff = await staffRepository.findById(staffId);
        if (!staff || staff.isWelcomeSent || !staff.user) return false;

        const telegramId = Number(staff.user.telegramId);
        const firstName = staff.fullName.split(' ')[1] || staff.fullName;

        const welcomeText = 
            `🌟 <b>Вітаємо в команді, ${firstName}!</b>\n\n` +
            `Твій перший робочий графік готовий! Ти вже можеш переглянути свої зміни в головному меню. 📸\n\n` +
            `🤝 <b>Твоя перша зміна:</b> Наша <b>наставниця</b> допоможе тобі онлайн з усіма технічними питаннями та адаптацією. Не хвилюйся, ми всьому навчимо! ✨\n\n` +
            `<b>Ось короткий гід по боту:</b>\n\n` +
            `📅 <b>Графік</b> — твій список змін та імена колег.\n\n` +
            `📋 <b>Мої завдання</b> — щоранку ти отримуватимеш список завдань ✅.\n\n` +
            `💬 <b>Підтримка</b> — якщо виникають питання — пиши сюди.\n\n` +
            `Бажаємо тобі класного старту! 🚀`;

        const kb = new InlineKeyboard()
            .text("🚀 Відкрити Хаб", "staff_hub_nav").row()
            .url("📖 База знань", TEAM_CHANNEL_LINK);

        try {
            await api.sendMessage(telegramId, welcomeText, { parse_mode: "HTML", reply_markup: kb });
            
            // 1. Mark welcome as sent
            await staffRepository.update(staff.id, { isWelcomeSent: true });

            // 2. Update user role
            if (staff.user.role === Role.CANDIDATE) {
                await userRepository.update(staff.userId, { role: Role.STAFF });
            }

            // 3. Update candidate status to HIRED
            const candidate = await candidateRepository.findByUserId(staff.userId);
            if (candidate && candidate.status !== CandidateStatus.HIRED) {
                await candidateRepository.update(candidate.id, { 
                    status: CandidateStatus.HIRED,
                    notificationSent: true 
                });
            }

            logger.info({ staffId, telegramId }, "✅ Finalized staff activation and sent welcome");
            return true;
        } catch (e) {
            logger.error({ err: e, staffId, telegramId }, "❌ Failed to send final welcome message");
            return false;
        }
    }

    async refreshAllStaffHubs(api: any) {
        const staff = await staffRepository.findActive();

        const keyboard = {
            inline_keyboard: [
                [{ text: "📸 Open Staff Menu ✨", callback_data: "staff_hub_nav" }]
            ]
        };

        const text = "👋 <b>Привіт! Ми оновили систему PlayPhoto.</b>\n\nБудь ласка, натисни кнопку нижче, щоб отримати актуальне меню та продовжити роботу! ✨";

        let count = 0;
        for (const s of staff) {
            if (s.user?.telegramId) {
                try {
                    const tid = Number(s.user.telegramId);
                    await api.sendMessage(tid, text, {
                        parse_mode: "HTML",
                        reply_markup: keyboard
                    });
                    count++;
                } catch (e) {
                    logger.error({ err: e, telegramId: s.user.telegramId }, "Failed to refresh hub for staff");
                }
            }
        }
        return count;
    }
}

export const staffService = new StaffService();
