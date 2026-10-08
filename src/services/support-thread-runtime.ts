import { ADMIN_IDS, CO_FOUNDER_IDS, SUPPORT_IDS, TEAM_CHATS } from "../config.js";
import { getAdminRoleByTelegramId, hasPermission } from "../config/roles.js";
import { AlbumBuffer } from "../utils/album-buffer.js";
import { SupportRelayService } from "./support-relay-service.js";
import { SupportEscalationService } from "./support-escalation-service.js";
import prisma from "../db/core.js";
import { supportThreadRepository } from "../repositories/support-thread-repository.js";
import { kyivDay } from "../utils/support-thread-format.js";
import { formatStaffShiftTime, SHIFT_TIME_NOT_SET } from "../utils/staff-shift-time.js";
import { supportConversationService } from "./support-conversation-service.js";
import { resolveThreadIcons } from "./support-thread-icons.js";
import { SupportThreadService, topicLink, type ThreadPeople, type ThreadPlace } from "./support-thread-service.js";

const DAY_MS = 86_400_000;

const toPlace = (location: { id: string; name: string; branch?: string | null; city?: string | null }): ThreadPlace => ({
    id: location.id,
    name: location.name,
    branch: location.branch ?? null,
    city: location.city ?? "",
});

/** Люди й зміни з бази бота; сьогоднішня зміна — з канону, як у хабі фотографині. */
export const threadPeople: ThreadPeople = {
    async getPerson(userId) {
        const staff = await prisma.staffProfile.findUnique({
            where: { userId },
            include: { user: { select: { username: true } }, location: true },
        });
        if (!staff) return null;
        return {
            userId,
            staffId: staff.id,
            fullName: staff.fullName,
            surnameNameDot: staff.surnameNameDot,
            phone: staff.phone,
            username: staff.user.username,
            isActive: staff.isActive,
            homeLocation: staff.location ? toPlace(staff.location) : null,
        };
    },

    async recentShiftLocations(staffId, now) {
        const shifts = await prisma.workShift.findMany({
            where: { staffId, date: { gte: new Date(now.getTime() - 60 * DAY_MS), lte: new Date(now.getTime() + 30 * DAY_MS) } },
            include: { location: true },
            orderBy: { date: "asc" },
        });
        return shifts.map(shift => toPlace(shift.location));
    },

    async todayShift(staffId, now) {
        const { getVisibleStaffShifts } = await import("../modules/staff/services/staff-schedule-view.js");
        const today = new Date(`${kyivDay(now)}T00:00:00.000Z`);
        const shifts = await getVisibleStaffShifts(staffId, today, 5, { canonicalRead: true });
        const shift = shifts.find(item => item.date.getTime() === today.getTime());
        if (!shift) return null;
        const time = formatStaffShiftTime(shift);
        return { location: toPlace(shift.location), time: time === SHIFT_TIME_NOT_SET ? null : time.replace("-", "–") };
    },
};

export const supportThreadService = new SupportThreadService({
    repo: supportThreadRepository,
    people: threadPeople,
    lock: (userId, fn) => supportConversationService.withUserLock(userId, fn),
    chatId: () => TEAM_CHATS.SUPPORT,
    icons: resolveThreadIcons,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    callTargets: () => ({ kuznetsov: ADMIN_IDS[0], hupalova: CO_FOUNDER_IDS[0] }),
});

export const supportRelayService = new SupportRelayService({
    threads: supportThreadService,
    repo: supportThreadRepository,
    timeline: async (userId, author, text, meta) => {
        const { timelineRepository } = await import("../repositories/timeline-repository.js");
        await timelineRepository.createEvent(userId, "MESSAGE", author, text, meta);
    },
    albums: new AlbumBuffer(),
    now: () => new Date(),
    supportChatId: () => TEAM_CHATS.SUPPORT,
    ignoredTopicIds: () => (TEAM_CHATS.LOGISTICS ? [TEAM_CHATS.LOGISTICS] : []),
    getStaffChatId: async userId => {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { telegramId: true } });
        return user ? Number(user.telegramId) : null;
    },
    isSupportMember: telegramId => hasPermission(getAdminRoleByTelegramId(BigInt(telegramId)), "SUPPORT_CHAT"),
    topicLink,
});

export const supportEscalationService = new SupportEscalationService({
    threads: supportThreadService,
    repo: supportThreadRepository,
    targets: () => ({ kuznetsov: ADMIN_IDS[0], hupalova: CO_FOUNDER_IDS[0], support: SUPPORT_IDS[0] }),
    topicLink,
});
