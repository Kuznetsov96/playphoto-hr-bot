import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu } from "@grammyjs/menu";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { scheduleSyncService } from "../../services/schedule-sync.js";
import { staffService } from "../../modules/staff/services/index.js";
import { getBirthdaysByMonth } from "../../services/birthday-service.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { workShiftRepository } from "../../repositories/work-shift-repository.js";
import { formatLocationName, normalizeCity } from "./utils.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";
import { chatLogRepository } from "../../repositories/chat-log-repository.js";
import { userRepository } from "../../repositories/user-repository.js";
import { startAdminStaffSearch } from "./search.js";
import { InputFile } from "grammy";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";

/**
 * Birthday Selection Menu
 */
export const adminBirthdayMenu = new Menu<MyContext>("admin-birthdays");
adminBirthdayMenu.dynamic(async (ctx, range) => {
    const currentMonth = new Date().getMonth() + 1;
    let col = 0;

    for (let num = 1; num <= 12; num++) {
        const name = ADMIN_TEXTS[`month-${num}` as keyof typeof ADMIN_TEXTS] || `Month ${num}`;
        const label = num === currentMonth ? `• ${name}` : name;
        range.text(label as string, async (ctx) => {
            await handleBirthdayMonthCallback(ctx, num);
        });
        col++;
        if (col % 3 === 0) range.row();
    }

    range.row().text(ADMIN_TEXTS["admin-bday-btn-all-months"], async (ctx) => {
        await handleBirthdayMonthCallback(ctx, 0);
    });
    range.row().text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
    });
});

async function showBirthdayMenu(ctx: MyContext) {
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bday-header-all"] + "\n\n" + ADMIN_TEXTS["admin-bday-select-month"], "admin-birthdays", { pushToStack: true });
}

export async function handleBirthdayMonthCallback(ctx: MyContext, month: number) {
    const text = await getBirthdaysByMonth(month === 0 ? undefined : month);
    const kb = new InlineKeyboard().text("⬅️ Back to Months", "admin_birthdays_back");
    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(ctx, text, kb, {
        pushToStack: true,
        manualMenuId: "admin-birthday-list"
    });
}

// --- 1. TEAM & OPS MENU ---
export const adminTeamOpsMenu = new Menu<MyContext>("admin-team-ops");
adminTeamOpsMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    let userRole = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
    }

    range.text("📅 Schedule", async (ctx) => {
        ctx.session.adminFlow = 'SCHEDULE';
        delete ctx.session.taskData;
        delete ctx.session.broadcastData;
        await ScreenManager.renderScreen(ctx, "📅 <b>Schedule</b>", "admin-schedule-dates", { pushToStack: true });
    }).row();

    range.text("🏢 Locations", async (ctx) => {
        ctx.session.adminFlow = 'LOCATIONS';
        delete ctx.session.selectedDate;
        delete ctx.session.selectedLocationId;
        delete ctx.session.taskData;
        delete ctx.session.broadcastData;
        await ScreenManager.renderScreen(ctx, "🏢 <b>Locations</b>", "admin-team-cities", { pushToStack: true });
    });

    range.text("🔍 Staff Search", async (ctx) => {
        ctx.session.adminFlow = 'SEARCH';
        delete ctx.session.selectedDate;
        delete ctx.session.selectedLocationId;
        delete ctx.session.taskData;
        delete ctx.session.broadcastData;
        await startAdminStaffSearch(ctx);
    }).row();

    // Only Super Admin can sync or see reports
    if (hasPermission(userRole as any, 'STAFF_SYNC')) {
        range.text("🔄 Full Sync", async (ctx) => {
            const msg = await ctx.reply("⏳ Starting Full System Sync...");
            try {
                // Get blocklist count BEFORE sync
                const prisma = (await import("../../db/core.js")).default;
                const blocklistBefore = await prisma.user.count({ where: { isBlocked: true } });

                const teamRes = await scheduleSyncService.syncTeam(ctx.api);

                // --- Snapshot shifts BEFORE schedule sync ---
                const shiftsBefore = await prisma.workShift.findMany({
                    where: { date: { gte: new Date() } },
                    select: { staffId: true, date: true, locationId: true }
                });
                const beforeMap = new Map<string, Set<string>>();
                for (const s of shiftsBefore) {
                    const key = `${s.date.toISOString()}|${s.locationId}`;
                    if (!beforeMap.has(s.staffId)) beforeMap.set(s.staffId, new Set());
                    beforeMap.get(s.staffId)!.add(key);
                }

                const schedRes = await scheduleSyncService.syncSchedule("Актуальний розклад", teamRes.teamMapping);

                // --- Snapshot shifts AFTER schedule sync ---
                const shiftsAfter = await prisma.workShift.findMany({
                    where: { date: { gte: new Date() } },
                    select: { staffId: true, date: true, locationId: true }
                });
                const afterMap = new Map<string, Set<string>>();
                for (const s of shiftsAfter) {
                    const key = `${s.date.toISOString()}|${s.locationId}`;
                    if (!afterMap.has(s.staffId)) afterMap.set(s.staffId, new Set());
                    afterMap.get(s.staffId)!.add(key);
                }

                // --- Diff: find staff whose schedule actually changed ---
                const changedStaffIds = new Set<string>();
                const allStaffIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
                for (const sid of allStaffIds) {
                    const before = beforeMap.get(sid);
                    const after = afterMap.get(sid);
                    if (!before && !after) continue;
                    if (!before || !after || before.size !== after.size) { changedStaffIds.add(sid); continue; }
                    for (const k of before) { if (!after.has(k)) { changedStaffIds.add(sid); break; } }
                }

                // --- NEW: Notify New Hires & Mentors ---
                const { TEAM_CHANNEL_LINK, MENTOR_IDS } = await import("../../config.js");
                const { staffRepository } = await import("../../repositories/staff-repository.js");

                const newHires = await staffRepository.findMany({
                    where: {
                        isWelcomeSent: false,
                        isActive: true,
                        shifts: { some: {} }
                    },
                    include: { user: { include: { candidate: true } } }
                });

                for (const staff of newHires) {
                    try {
                        if (!staff.user) continue;
                        const staffTgId = Number(staff.user.telegramId);

                        // 1. Send generic welcome & flip role
                        const { staffService } = await import("../../modules/staff/services/index.js");
                        await staffService.finalizeStaffActivation(staff.id, ctx.api);

                        // 2. Send follow-up with the actual schedule
                        const upcomingShifts = await prisma.workShift.findMany({
                            where: { staffId: staff.id, date: { gte: new Date() } },
                            orderBy: { date: 'asc' },
                            include: { location: true },
                            take: 30
                        });

                        if (upcomingShifts.length > 0) {
                            let schedMsg = `📅 <b>Твій графік:</b>\n\n`;
                            for (const s of upcomingShifts) {
                                const raw = s.date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", weekday: "short" });
                                const dateStr = raw.charAt(0).toUpperCase() + raw.slice(1);
                                schedMsg += `▫️ <code>${dateStr}</code> — ${s.location.name}\n`;
                            }
                            schedMsg += `\n✨ Ти можеш переглянути графік будь-коли в меню бота.`;
                            const schedKb = new InlineKeyboard().text("🚀 Відкрити Хаб", "staff_hub_nav");
                            await ctx.api.sendMessage(staffTgId, schedMsg, { parse_mode: "HTML", reply_markup: schedKb }).catch(() => { });
                        }

                        // 3. Notify mentor
                        const firstShift = upcomingShifts[0];
                        if (firstShift && MENTOR_IDS.length > 0) {
                            const dateStr = firstShift.date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
                            const mentorMsg =
                                `🎓 <b>New Staff Onboarding!</b>\n\n` +
                                `👤 Name: <b>${staff.fullName}</b>\n` +
                                `📅 First Shift: <b>${dateStr}</b>\n` +
                                `📍 Location: <b>${firstShift.location.name}</b>\n\n` +
                                `Please control their first day and help with adaptation! ✨`;

                            const mentorKb = new InlineKeyboard().text("👤 Profile", `view_staff_${staff.id}`);
                            await ctx.api.sendMessage(MENTOR_IDS[0]!, mentorMsg, { parse_mode: "HTML", reply_markup: mentorKb }).catch(() => { });
                        }
                    } catch (err) {
                        logger.error({ err, staffId: staff.id }, "❌ Failed to send welcome/mentor notification in Full Sync");
                    }
                }

                // --- Notify existing staff whose schedule actually changed ---
                let staffNotified = 0;
                const newHireIds = new Set(newHires.map(h => h.id));
                if (changedStaffIds.size > 0) {
                    const staffToNotify = await staffRepository.findMany({
                        where: {
                            id: { in: Array.from(changedStaffIds) },
                            isActive: true,
                            isWelcomeSent: true
                        },
                        include: { user: true }
                    });

                    for (const s of staffToNotify) {
                        if (!s.user || newHireIds.has(s.id)) continue;
                        try {
                            const updateMsg = `📅 <b>Графік оновлено!</b>\n\nПереглянь свої зміни — можливо, є зміни у датах чи локації. ✨`;
                            const updateKb = new InlineKeyboard().text("🗓 Мій графік", "staff_hub_nav");
                            await ctx.api.sendMessage(Number(s.user.telegramId), updateMsg, { parse_mode: "HTML", reply_markup: updateKb }).catch(() => { });
                            staffNotified++;
                        } catch { /* skip */ }
                    }
                }

                let report = `✅ <b>Sync Complete!</b>\n\n`;

                const teamDelta = (teamRes.activeAfter || 0) - (teamRes.activeBefore || 0);
                const teamDeltaStr = teamDelta >= 0 ? `+${teamDelta}` : `${teamDelta}`;
                report += `👥 Team: <b>${teamRes.activeAfter || 0}</b> (${teamDeltaStr})\n`;

                const shiftDelta = (schedRes.shiftsAfter || 0) - (schedRes.shiftsBefore || 0);
                const shiftDeltaStr = shiftDelta >= 0 ? `+${shiftDelta}` : `${shiftDelta}`;
                report += `📅 Shifts: <b>${schedRes.shiftsAfter || 0}</b> (${shiftDeltaStr})\n`;

                if (teamRes.blocklistRes) {
                    const bl = teamRes.blocklistRes;
                    if (bl.success) {
                        const blocklistDelta = (bl.count || 0) - (typeof blocklistBefore !== 'undefined' ? blocklistBefore : 0);
                        const blocklistDeltaStr = blocklistDelta >= 0 ? `+${blocklistDelta}` : `${blocklistDelta}`;
                        report += `🛡️ Blocklist: <b>${bl.count}</b> (${blocklistDeltaStr})\n`;
                    } else {
                        report += `🛡️ Blocklist: ⚠️ Failed (${bl.error})\n`;
                    }
                }

                if (newHires.length > 0) {
                    report += `📢 <b>${newHires.length}</b> new hires notified! ✨\n`;
                }
                if (staffNotified > 0) {
                    report += `📅 <b>${staffNotified}</b> staff notified about schedule changes`;
                }

                await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, report, { parse_mode: "HTML" });
            } catch (e: any) {
                logger.error({ err: e, telegramId }, "❌ [SYNC] Full sync failed:");
                await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ <b>Sync Error:</b> ${e.message}`, { parse_mode: "HTML" });
            }
        });
        range.text("📂 Custom Sync", async (ctx) => {
            ctx.session.step = "sync_other_sheet";
            await ctx.reply(ADMIN_TEXTS["admin-sync-enter-sheet"]);
        }).row();
    }

    if (userRole !== 'SUPPORT') {
        range.text("🎂 Birthdays", async (ctx) => {
            await showBirthdayMenu(ctx);
        });

        range.text("⚠️ Inactive", async (ctx) => {
            const report = await staffService.getInactiveStaffReport();
            await ctx.reply(report, { parse_mode: "HTML" });
        }).row();
    }

    range.text("⬅️ Back", async (ctx) => {
        const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

// --- NEW SCHEDULE FLOW ---
export const adminScheduleDateMenu = new Menu<MyContext>("admin-schedule-dates");
adminScheduleDateMenu.dynamic(async (ctx, range) => {
    // 1. Static buttons first (Today, Tomorrow, History)
    range.text("📅 Today", async (ctx) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        ctx.session.selectedDate = d.toISOString();
        await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
    });
    range.text("📅 Tomorrow", async (ctx) => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        ctx.session.selectedDate = d.toISOString();
        await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
    });
    range.text(ADMIN_TEXTS["admin-schedule-history"], async (ctx) => {
        await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-schedule-history-title"], "admin-schedule-history", { pushToStack: true });
    }).row();

    // 2. Next 7 days
    for (let i = 2; i < 9; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        d.setHours(0, 0, 0, 0);
        const dayStr = d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
        range.text(dayStr, async (ctx) => {
            ctx.session.selectedDate = d.toISOString();
            await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
        });
        // Row every 3 buttons
        if ((i - 2 + 1) % 3 === 0) range.row();
    }

    // Gaps Button (at the bottom)
    range.row().text(ADMIN_TEXTS["admin-schedule-gaps"], async (ctx) => {
        const { scheduleGapService } = await import("../../services/schedule-gap-service.js");
        const gaps = await scheduleGapService.findGaps(7);
        const report = scheduleGapService.formatGapReport(gaps);

        await ScreenManager.renderScreen(ctx, report, new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-back"], "back_to_schedule_dates"), { pushToStack: true });
    });

    // Ensure row before Back
    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
    });
});

// Add back button for Gaps view
export const adminTeamHandlers = new Composer<MyContext>();
adminTeamHandlers.callbackQuery("back_to_schedule_dates", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-schedule-select-date"], "admin-schedule-dates");
});

export const adminScheduleHistoryMenu = new Menu<MyContext>("admin-schedule-history");
adminScheduleHistoryMenu.dynamic(async (ctx, range) => {
    for (let i = 1; i <= 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        const dayStr = d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
        range.text(dayStr, async (ctx) => {
            ctx.session.selectedDate = d.toISOString();
            await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
        });
        if (i % 3 === 0) range.row();
    }
    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-schedule-select-date"], "admin-schedule-dates");
    });
});

export const adminScheduleCityMenu = new Menu<MyContext>("admin-schedule-cities");
adminScheduleCityMenu.dynamic(async (ctx, range) => {
    const cities = await locationRepository.findAllCities();
    cities.sort().forEach(city => {
        range.text(normalizeCity(city), async (ctx) => {
            if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
            ctx.session.candidateData.city = city;
            await ScreenManager.renderScreen(ctx, `📍 <b>Select Location in ${normalizeCity(city)}:</b>`, "admin-schedule-locations", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Select Date:</b>", "admin-schedule-dates");
    });
});

export const adminScheduleLocMenu = new Menu<MyContext>("admin-schedule-locations");
adminScheduleLocMenu.dynamic(async (ctx, range) => {
    if (!ctx.session.candidateData) ctx.session.candidateData = {};
    const city = ctx.session.candidateData.city;
    if (!city) return;

    const locations = await locationRepository.findByCity(city);
    locations.forEach((l: any) => {
        range.text(formatLocationName(l.name, city), async (ctx) => {
            ctx.session.selectedLocationId = l.id;
            await ScreenManager.renderScreen(ctx, "👥 <b>Select Staff:</b>", "admin-schedule-staff", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🏢 <b>Select City:</b>", "admin-schedule-cities");
    });
});

export const adminScheduleStaffMenu = new Menu<MyContext>("admin-schedule-staff");
adminScheduleStaffMenu.dynamic(async (ctx, range) => {
    const locId = ctx.session.selectedLocationId;
    const dateStr = ctx.session.selectedDate;
    if (!locId || !dateStr) return;

    const date = new Date(dateStr);
    const endOfDay = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    const shifts = await workShiftRepository.findByLocationAndDateRange(locId, date, endOfDay);

    if (shifts.length === 0) {
        range.text("📭 No shifts", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-shifts-none"])).row();
    } else {
        const staffMap = new Map<string, any>();
        shifts.forEach((s: any) => staffMap.set(s.staff.id, s.staff));
        const uniqueStaff = Array.from(staffMap.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));

        uniqueStaff.forEach((staff: any) => {
            range.text(`👤 ${staffService.shortenName(staff.fullName)}`, async (ctx) => {
                ctx.session.selectedUserId = staff.userId;
                const profile = staff;
                const viewerRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
                const text = (await staffService.getProfileText(profile, false, viewerRole)) + `\n${ADMIN_TEXTS["admin-profile-select-action"]}`;

                const kb = new InlineKeyboard()
                    .text("💬 Write Message", `admin_send_msg_${staff.userId}`).row()
                    .text("📝 Set Task", `admin_send_task_${staff.userId}`).row();

                if (viewerRole === "SUPER_ADMIN") {
                    kb.text("📋 Chat History", `admin_timeline_export_${staff.userId}`).row();
                }
                kb.text(ADMIN_TEXTS["admin-btn-back"], "back_to_schedule_staff");
                await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
            }).row();
        });
    }
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📍 <b>Select Location:</b>", "admin-schedule-locations");
    });
});

// --- CITY/LOC GROUPING FOR TEAM (STAFF VIEW) ---
export const adminTeamCityMenu = new Menu<MyContext>("admin-team-cities");
adminTeamCityMenu.dynamic(async (ctx, range) => {
    const cities = await locationRepository.findAllCities();
    cities.sort().forEach(city => {
        range.text(normalizeCity(city), async (ctx) => {
            if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
            ctx.session.candidateData.city = city;
            await ScreenManager.renderScreen(ctx, `📍 <b>Select Location in ${normalizeCity(city)}:</b>`, "admin-team-locations", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
    });
});

export const adminTeamLocMenu = new Menu<MyContext>("admin-team-locations");
adminTeamLocMenu.dynamic(async (ctx, range) => {
    if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
    const city = ctx.session.candidateData.city;
    if (!city) return;

    const locations = await locationRepository.findByCity(city);
    locations.forEach((l: any) => {
        range.text(formatLocationName(l.name, city), async (ctx) => {
            ctx.session.selectedLocationId = l.id;
            await ScreenManager.renderScreen(ctx, "👥 <b>Select Staff:</b>", "admin-location-staff", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "🏢 <b>Select City:</b>", "admin-team-cities");
    });
});

export const adminLocationStaffMenu = new Menu<MyContext>("admin-location-staff");
adminLocationStaffMenu.dynamic(async (ctx, range) => {
    const locId = ctx.session.selectedLocationId;
    if (!locId) return;

    const staff = (await staffRepository.findByLocation(locId))
        .sort((a: any, b: any) => a.fullName.localeCompare(b.fullName));

    if (staff.length === 0) {
        range.text("📭 No staff here", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-staff-none-loc"])).row();
    } else {
        staff.forEach((s: any) => {
            range.text(`👤 ${staffService.shortenName(s.fullName)}`, async (ctx) => {
                ctx.session.selectedUserId = s.userId;
                const viewerRole = ctx.from?.id ? await getUserAdminRole(BigInt(ctx.from.id)) : null;
                const text = (await staffService.getProfileText(s, false, viewerRole)) + `\n${ADMIN_TEXTS["admin-profile-select-action"]}`;

                const kb = new InlineKeyboard()
                    .text("💬 Write Message", `admin_send_msg_${s.userId}`).row()
                    .text("📝 Set Task", `admin_send_task_${s.userId}`).row();

                if (viewerRole === "SUPER_ADMIN") {
                    kb.text("📋 Chat History", `admin_timeline_export_${s.userId}`).row();
                }
                kb.text(ADMIN_TEXTS["admin-btn-back"], "back_to_loc_staff");
                await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
            }).row();
        });
    }
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📍 <b>Select Location:</b>", "admin-team-locations");
    });
});
