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
import { systemStateRepository } from "../../repositories/system-state-repository.js";
import { escapeHtml, formatLocationName, normalizeCity } from "./utils.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";
import { chatLogRepository } from "../../repositories/chat-log-repository.js";
import { userRepository } from "../../repositories/user-repository.js";
import { startAdminStaffSearch } from "./search.js";
import { InputFile } from "grammy";
import logger from "../../core/logger.js";
import { audit } from "../../core/audit-logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { MAIN_ADMIN_ID, replacementService } from "../../services/replacement-service.js";
import { startManualChannelAccessFlow, startManualChannelRevokeFlow } from "./manual-channel-access.js";
import { getShiftTimeFromLocationSchedule } from "../../utils/shift-time.js";

function formatShiftClock(date: Date) {
    return date.toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Kyiv"
    });
}

function formatScheduleNotificationShiftTime(shift: {
    date: Date;
    startTime?: Date | null;
    endTime?: Date | null;
    location?: { schedule?: string | null } | null;
}) {
    if (shift.startTime && shift.endTime) {
        return `${formatShiftClock(shift.startTime)}-${formatShiftClock(shift.endTime)}`;
    }

    return getShiftTimeFromLocationSchedule(shift.location?.schedule, shift.date) || "час не вказано";
}

function formatTeamSyncPreview(preview: any): string {
    const duplicatePreview = (preview.duplicateTelegramIds || [])
        .slice(0, 5)
        .map((item: any) => `• <code>${item.telegramId}</code> — rows ${item.rows.join(", ")}`)
        .join("\n");

    const deactivationPreview = (preview.deactivationCandidates || [])
        .slice(0, 8)
        .map((item: any) => `• ${item.fullName} — row ${item.rowNumber} — <code>${item.rawStatus}</code>`)
        .join("\n");

    let text = `🔎 <b>Full Sync Preview</b>\n\n` +
        `👥 Active in DB now: <b>${preview.activeBefore}</b>\n` +
        `📄 Visible team rows: <b>${preview.visibleStaffRows}</b>\n` +
        `🙈 Hidden team rows: <b>${preview.hiddenStaffRows}</b>\n` +
        `✅ Active rows in sheet: <b>${preview.activeRows}</b>\n` +
        `⛔ Inactive rows in sheet: <b>${preview.inactiveRows}</b>\n` +
        `❓ Unknown statuses: <b>${preview.unknownStatusRows}</b>\n` +
        `🧯 Deactivation candidates: <b>${preview.deactivationCandidates.length}</b>\n` +
        `🪪 Duplicate Telegram IDs: <b>${preview.duplicateTelegramIds.length}</b>\n`;

    if (preview.duplicateTelegramIds?.length) {
        text += `\n⚠️ <b>Duplicates detected</b>\n${duplicatePreview}\n`;
    }

    if (preview.deactivationCandidates?.length) {
        text += `\n⚠️ <b>Will deactivate on confirm</b>\n${deactivationPreview}\n`;
    }

    if (!preview.duplicateTelegramIds?.length && !preview.deactivationCandidates?.length && !preview.unknownStatusRows) {
        text += `\nNo risky changes detected.`;
    }

    return text;
}

async function executeFullSync(ctx: MyContext, msg: any) {
    const telegramId = ctx.from?.id;
    audit({ event: "team_sync", result: "started", actorType: "admin", telegramId, entityType: "system", updateId: ctx.update.update_id });
    try {
        const prisma = (await import("../../db/core.js")).default;
        const blocklistBefore = await prisma.user.count({ where: { isBlocked: true } });

        const teamRes = await scheduleSyncService.syncTeam(ctx.api);

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

        const changedStaffIds = new Set<string>();
        const allStaffIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
        for (const sid of allStaffIds) {
            const before = beforeMap.get(sid);
            const after = afterMap.get(sid);
            if (!before && !after) continue;
            if (!before || !after || before.size !== after.size) { changedStaffIds.add(sid); continue; }
            for (const k of before) { if (!after.has(k)) { changedStaffIds.add(sid); break; } }
        }

        const { TEAM_CHANNEL_LINK, MENTOR_IDS } = await import("../../config.js");
        const { staffRepository } = await import("../../repositories/staff-repository.js");
        const { AdminRole } = await import("@prisma/client");
        const excludedRoles = [AdminRole.SUPER_ADMIN, AdminRole.CO_FOUNDER, AdminRole.SUPPORT, AdminRole.HR_LEAD, AdminRole.MENTOR_LEAD];

        const newHires = await staffRepository.findMany({
            where: {
                isWelcomeSent: false,
                isActive: true,
                shifts: { some: {} },
                user: {
                    OR: [
                        { adminRole: null },
                        { adminRole: { notIn: excludedRoles } }
                    ]
                }
            },
            include: { user: { include: { candidate: true } } }
        });

        let newHiresNotified = 0;
        for (const staff of newHires) {
            try {
                if (!staff.user) continue;
                const staffTgId = Number(staff.user.telegramId);
                const { staffService } = await import("../../modules/staff/services/index.js");
                const welcomed = await staffService.finalizeStaffActivation(staff.id, ctx.api);

                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);
                const upcomingShifts = await prisma.workShift.findMany({
                    where: { staffId: staff.id, date: { gte: startOfToday } },
                    orderBy: { date: 'asc' },
                    include: { location: true },
                    take: 30
                });

                if (welcomed) {
                    newHiresNotified++;
                    if (upcomingShifts.length > 0) {
                        let schedMsg = `📅 <b>Твій графік:</b>\n\n`;
                        for (const s of upcomingShifts) {
                            const raw = s.date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", weekday: "short" });
                            const dateStr = raw.charAt(0).toUpperCase() + raw.slice(1);
                            const timeStr = formatScheduleNotificationShiftTime(s);
                            schedMsg += `▫️ <code>${dateStr}</code> — ${escapeHtml(timeStr)} — ${escapeHtml(s.location.name)}\n`;
                        }
                        schedMsg += `\n✨ Ти можеш переглянути графік будь-коли в меню бота.`;
                        const schedKb = new InlineKeyboard().text("🚀 Відкрити Хаб", "staff_hub_nav");
                        await ctx.api.sendMessage(staffTgId, schedMsg, { parse_mode: "HTML", reply_markup: schedKb }).catch(() => { });
                    }
                }

                const firstShift = upcomingShifts[0];
                if (welcomed && firstShift && MENTOR_IDS.length > 0) {
                    const dateStr = firstShift.date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
                    const mentorMsg =
                        `📅 <b>New Staff First Shift Scheduled</b>\n\n` +
                        `👤 Name: <b>${staff.fullName}</b>\n` +
                        `📅 First Shift: <b>${dateStr}</b>\n` +
                        `📍 Location: <b>${firstShift.location.name}</b>\n\n` +
                        `Schedule is ready; no separate mentor onboarding is required.`;
                    const mentorKb = new InlineKeyboard().text("👤 Profile", `view_staff_${staff.id}`);
                    await ctx.api.sendMessage(MENTOR_IDS[0]!, mentorMsg, { parse_mode: "HTML", reply_markup: mentorKb }).catch(() => { });
                }

                if (firstShift) {
                    await scheduleSyncService.updateFirstShiftDateInSheet(
                        staff.user.telegramId.toString(), firstShift.date
                    ).catch(() => { });
                }
            } catch (err) {
                logger.error({ err, staffId: staff.id }, "Team sync welcome or mentor notification failed");
            }
        }

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
                } catch { }
            }
        }

        let report = `✅ <b>Sync Complete!</b>\n\n`;

        const teamDelta = (teamRes.activeAfter || 0) - (teamRes.activeBefore || 0);
        const teamDeltaStr = teamDelta >= 0 ? `+${teamDelta}` : `${teamDelta}`;
        report += `👥 Team: <b>${teamRes.activeAfter || 0}</b> (${teamDeltaStr})\n`;
        if ((teamRes.inactiveStaffRemovedFromChats || 0) > 0) {
            report += `🧹 Removed from chats: <b>${teamRes.inactiveStaffRemovedFromChats}</b>\n`;
        }
        if ((teamRes.unknownStatusRows || 0) > 0) {
            report += `❓ Unknown status rows skipped: <b>${teamRes.unknownStatusRows}</b>\n`;
        }
        const removalFailures = teamRes.inactiveStaffRemovalFailures || [];
        if (removalFailures.length > 0) {
            const failedChatIds = Array.from(new Set(
                removalFailures.map((failure: any) => String(failure.chatId))
            )).slice(0, 6);
            report += `⚠️ Chat removals failed: <b>${removalFailures.length}</b>`;
            if (failedChatIds.length > 0) {
                report += ` (${failedChatIds.join(', ')})`;
            }
            report += `\n`;
        }

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

        if (newHiresNotified > 0) {
            report += `📢 <b>${newHiresNotified}</b> new hires notified! ✨\n`;
        }
        if (newHires.length > newHiresNotified) {
            report += `⚠️ <b>${newHires.length - newHiresNotified}</b> new hires unreachable (haven't started bot)\n`;
        }
        if (staffNotified > 0) {
            report += `📅 <b>${staffNotified}</b> staff notified about schedule changes`;
        }

        audit({ event: "team_sync", result: "success", actorType: "admin", telegramId, entityType: "system", updateId: ctx.update.update_id });
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, report, { parse_mode: "HTML" });
    } catch (e: any) {
        audit({ event: "team_sync", result: "failed", actorType: "admin", telegramId, entityType: "system", updateId: ctx.update.update_id, error: e.message });
        logger.error({ err: e, telegramId }, "Team full sync failed");
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ <b>Sync Error:</b> ${e.message}`, { parse_mode: "HTML" });
    } finally {
        delete ctx.session.teamSyncPreview;
    }
}

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
        if (userRole === "SUPER_ADMIN") {
            range.text(ADMIN_TEXTS["admin-main-channel"], async (ctx) => {
                await ScreenManager.renderScreen(
                    ctx,
                    `${ADMIN_TEXTS["admin-channel-title"]}\n\n${ADMIN_TEXTS["admin-channel-menu-prompt"]}`,
                    "admin-channel",
                    { pushToStack: true }
                );
            }).row();
        }

        range.text("🔄 Full Sync", async (ctx) => {
            const telegramId = ctx.from?.id;
            const preview = await scheduleSyncService.previewTeamSync(telegramId);
            ctx.session.teamSyncPreview = {
                token: preview.token,
                generatedAt: Date.now(),
                requiresConfirmation: preview.requiresConfirmation,
            };

            const kb = new InlineKeyboard();
            if (!preview.duplicateTelegramIds.length) {
                kb.text(preview.requiresConfirmation ? "⚠️ Confirm Full Sync" : "✅ Run Full Sync", "team_sync_confirm");
            }
            kb.text("✖️ Cancel", "team_sync_cancel");

            await ctx.reply(formatTeamSyncPreview(preview), {
                parse_mode: "HTML",
                reply_markup: kb
            });
        });
        range.text("📂 Custom Sync", async (ctx) => {
            ctx.session.step = "sync_other_sheet";
            const prompt = await ctx.reply(ADMIN_TEXTS["admin-sync-enter-sheet"]);
            ctx.session.customSyncPromptMessageId = prompt.message_id;
            ctx.session.messagesToDelete.push(prompt.message_id);
        }).row();
    }

    if (userRole !== 'SUPPORT') {
        range.text("🎂 Birthdays", async (ctx) => {
            await showBirthdayMenu(ctx);
        }).row();
    }

    range.text("⬅️ Back", async (ctx) => {
        const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

export const adminChannelMenu = new Menu<MyContext>("admin-channel");
adminChannelMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    const userRole = telegramId ? await getUserAdminRole(BigInt(telegramId)) : null;

    if (userRole !== "SUPER_ADMIN") {
        range.text("⛔ No access", async (ctx) => {
            await ctx.answerCallbackQuery({ text: "No access.", show_alert: true });
        }).row();
    } else {
        range.text(ADMIN_TEXTS["admin-channel-grant"], async (ctx) => {
            await startManualChannelAccessFlow(ctx);
        }).row();

        range.text(ADMIN_TEXTS["admin-channel-revoke"], async (ctx) => {
            await startManualChannelRevokeFlow(ctx);
        }).row();
    }

    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
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

    if (ctx.from?.id === MAIN_ADMIN_ID) {
        range.text("🔎 Replacement Searches", async (ctx) => {
            await showAdminReplacementBoard(ctx);
        });
    }

    // Ensure row before Back
    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
    });
});

// Add back button for Gaps view
export const adminTeamHandlers = new Composer<MyContext>();
async function showAdminReplacementBoard(ctx: MyContext, forceNew: boolean = false) {
    if (ctx.from?.id !== MAIN_ADMIN_ID) {
        await ctx.answerCallbackQuery("Access denied").catch(() => { });
        return;
    }

    const requests = await replacementService.listActiveRequestsForAdmin();
    const kb = new InlineKeyboard();

    requests.slice(0, 8).forEach((request, index) => {
        kb.text(`❌ Cancel #${index + 1}`, `admin_repl_cancel_${request.id}`).row();
    });

    kb.text("➕ Start manual search", "admin_repl_manual_start").row()
        .text("🔄 Refresh", "admin_repl_board").row()
        .text(ADMIN_TEXTS["admin-btn-back"], "back_to_schedule_dates");

    await ScreenManager.renderScreen(
        ctx,
        replacementService.formatAdminBoardText(requests),
        kb,
        { forceNew, pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function ensureMainAdmin(ctx: MyContext) {
    if (ctx.from?.id === MAIN_ADMIN_ID) return true;
    await ctx.answerCallbackQuery("Access denied").catch(() => { });
    return false;
}

async function showAdminReplacementCityPicker(ctx: MyContext) {
    if (!(await ensureMainAdmin(ctx))) return;

    const cities = (await locationRepository.findAllCities()).sort((a, b) => normalizeCity(a).localeCompare(normalizeCity(b)));
    (ctx.session as any).adminReplacementCities = cities;
    delete (ctx.session as any).adminReplacementLocationIds;
    delete (ctx.session as any).adminReplacementDraft;

    const kb = new InlineKeyboard();
    cities.forEach((city, index) => {
        kb.text(normalizeCity(city), `admin_repl_city_${index}`);
        if ((index + 1) % 2 === 0) kb.row();
    });
    kb.row().text("⬅️ Back", "admin_repl_board");

    await ScreenManager.renderScreen(
        ctx,
        "➕ <b>Manual replacement search</b>\n\nSelect the city with an empty shift day.",
        kb,
        { forceNew: true, pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function showAdminReplacementLocationPicker(ctx: MyContext, cityIndex: number) {
    if (!(await ensureMainAdmin(ctx))) return;

    const cities = (ctx.session as any).adminReplacementCities as string[] | undefined;
    const city = cities?.[cityIndex];
    if (!city) {
        await ctx.answerCallbackQuery("Selection expired").catch(() => { });
        await showAdminReplacementCityPicker(ctx);
        return;
    }

    const locations = (await locationRepository.findByCity(city)).sort((a, b) => a.name.localeCompare(b.name));
    (ctx.session as any).adminReplacementLocationIds = locations.map(location => location.id);
    (ctx.session as any).adminReplacementDraft = { city };

    const kb = new InlineKeyboard();
    locations.slice(0, 20).forEach((location) => {
        kb.text(formatLocationName(location.name, location.city), `admin_repl_loc_${location.id}`).row();
    });
    kb.text("⬅️ Cities", "admin_repl_manual_start");

    await ScreenManager.renderScreen(
        ctx,
        `➕ <b>Manual replacement search</b>\n\nCity: <b>${escapeHtml(normalizeCity(city))}</b>\nSelect location.`,
        kb,
        { forceNew: true, pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function showAdminReplacementDatePicker(ctx: MyContext, locationId: string) {
    if (!(await ensureMainAdmin(ctx))) return;

    const location = await locationRepository.findById(locationId);
    if (!location) {
        await ctx.answerCallbackQuery("Location not found").catch(() => { });
        return;
    }

    const options = await replacementService.listManualSearchDateOptions(locationId, 14);
    (ctx.session as any).adminReplacementDraft = {
        city: location.city,
        locationId,
        locationName: location.name,
    };

    const kb = new InlineKeyboard();
    options.slice(0, 14).forEach((option, index) => {
        kb.text(option.label, `admin_repl_date_${option.dateKey}`);
        if ((index + 1) % 2 === 0) kb.row();
    });
    const cityIndex = ((ctx.session as any).adminReplacementCities || []).indexOf(location.city);
    kb.row().text("⬅️ Locations", cityIndex >= 0 ? `admin_repl_city_${cityIndex}` : "admin_repl_manual_start");

    const body = options.length > 0
        ? "Select an empty day. The search will use the location's regular shift time."
        : "No empty days without an active search were found in the next 14 days.";

    await ScreenManager.renderScreen(
        ctx,
        `➕ <b>Manual replacement search</b>\n\nLocation: <b>${escapeHtml(formatLocationName(location.name, location.city))}</b>\n${body}`,
        kb,
        { forceNew: true, pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function showAdminReplacementManualConfirm(ctx: MyContext, dateKey: string) {
    if (!(await ensureMainAdmin(ctx))) return;

    const draft = (ctx.session as any).adminReplacementDraft as { locationId?: string; locationName?: string; city?: string } | undefined;
    if (!draft?.locationId || !draft.locationName) {
        await ctx.answerCallbackQuery("Selection expired").catch(() => { });
        await showAdminReplacementCityPicker(ctx);
        return;
    }

    (ctx.session as any).adminReplacementDraft = { ...draft, dateKey };
    const options = await replacementService.listManualSearchDateOptions(draft.locationId, 14);
    const option = options.find(item => item.dateKey === dateKey);
    if (!option) {
        await ctx.answerCallbackQuery("This day is no longer available").catch(() => { });
        await showAdminReplacementDatePicker(ctx, draft.locationId);
        return;
    }

    const kb = new InlineKeyboard()
        .text("✅ Start search", "admin_repl_manual_confirm").row()
        .text("⬅️ Dates", `admin_repl_loc_${draft.locationId}`)
        .text("✖️ Cancel", "admin_repl_board");

    await ScreenManager.renderScreen(
        ctx,
        `➕ <b>Start manual replacement search?</b>\n\n` +
        `📍 <b>${escapeHtml(formatLocationName(draft.locationName, draft.city || ""))}</b>\n` +
        `📅 <b>${escapeHtml(option.label)}</b>\n\n` +
        `The bot will ask available photographers using the usual replacement waves.`,
        kb,
        { forceNew: true, pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function confirmAdminReplacementManualSearch(ctx: MyContext) {
    if (!(await ensureMainAdmin(ctx))) return;

    const draft = (ctx.session as any).adminReplacementDraft as { locationId?: string; dateKey?: string } | undefined;
    if (!draft?.locationId || !draft.dateKey) {
        await ctx.answerCallbackQuery("Selection expired").catch(() => { });
        await showAdminReplacementCityPicker(ctx);
        return;
    }

    try {
        await replacementService.startAdminRequest(ctx.api, draft.locationId, new Date(`${draft.dateKey}T00:00:00.000Z`));
        delete (ctx.session as any).adminReplacementDraft;
        await ctx.answerCallbackQuery("Search started").catch(() => { });
        await showAdminReplacementBoard(ctx, true);
    } catch (error: any) {
        let message = "Could not start the search.";
        if (error?.message === "REQUEST_ALREADY_ACTIVE") {
            message = "A search is already active for this location and date.";
        } else if (error?.message === "REQUEST_ALREADY_FOUND") {
            message = "A replacement was already found for this location and date. Update and sync the schedule first.";
        } else if (error?.message === "REQUEST_PREVIOUSLY_FAILED") {
            message = "A search already finished without a replacement for this location and date.";
        } else if (error?.message === "LOCATION_DAY_ALREADY_HAS_SHIFT") {
            message = "This location already has a shift on that day.";
        } else if (error?.message === "SHIFT_ALREADY_STARTED") {
            message = "This shift time has already started.";
        }
        await ctx.answerCallbackQuery({ text: message, show_alert: true });
    }
}

adminTeamHandlers.callbackQuery("admin_repl_board", async (ctx) => {
    await showAdminReplacementBoard(ctx, true);
});

adminTeamHandlers.callbackQuery("admin_repl_manual_start", async (ctx) => {
    await showAdminReplacementCityPicker(ctx);
});

adminTeamHandlers.callbackQuery(/^admin_repl_city_(\d+)$/, async (ctx) => {
    await showAdminReplacementLocationPicker(ctx, Number(ctx.match![1]));
});

adminTeamHandlers.callbackQuery(/^admin_repl_loc_(.+)$/, async (ctx) => {
    await showAdminReplacementDatePicker(ctx, ctx.match![1]!);
});

adminTeamHandlers.callbackQuery(/^admin_repl_date_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await showAdminReplacementManualConfirm(ctx, ctx.match![1]!);
});

adminTeamHandlers.callbackQuery("admin_repl_manual_confirm", async (ctx) => {
    await confirmAdminReplacementManualSearch(ctx);
});

adminTeamHandlers.callbackQuery(/^admin_repl_cancel_(.+)$/, async (ctx) => {
    if (ctx.from?.id !== MAIN_ADMIN_ID) {
        await ctx.answerCallbackQuery("Access denied").catch(() => { });
        return;
    }

    const requestId = ctx.match![1]!;
    const cancelled = await replacementService.cancelRequestByAdmin(ctx.api, requestId);
    await ctx.answerCallbackQuery(cancelled ? "Search cancelled" : "Search is already inactive").catch(() => { });
    await showAdminReplacementBoard(ctx, true);
});

adminTeamHandlers.callbackQuery("back_to_schedule_dates", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-schedule-select-date"], "admin-schedule-dates");
});

adminTeamHandlers.callbackQuery("team_sync_cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Sync cancelled");
    delete ctx.session.teamSyncPreview;
    await ctx.editMessageText("❌ <b>Full Sync cancelled.</b>", { parse_mode: "HTML" }).catch(() => { });
});

adminTeamHandlers.callbackQuery("team_sync_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();

    const previewMeta = ctx.session.teamSyncPreview;
    if (!previewMeta) {
        await ctx.reply("❌ Sync preview expired. Start Full Sync again.");
        return;
    }

    const preview = await systemStateRepository.getJson<any>(`team-sync-preview:${previewMeta.token}`);
    if (!preview) {
        delete ctx.session.teamSyncPreview;
        await ctx.reply("❌ Sync preview not found. Start Full Sync again.");
        return;
    }

    if ((preview.duplicateTelegramIds || []).length > 0) {
        await ctx.editMessageText("❌ <b>Sync blocked.</b>\n\nDuplicate Telegram IDs detected in the team sheet. Fix the sheet first and rerun preview.", { parse_mode: "HTML" }).catch(() => { });
        delete ctx.session.teamSyncPreview;
        return;
    }

    const ageMs = Date.now() - previewMeta.generatedAt;
    if (ageMs > 15 * 60 * 1000) {
        delete ctx.session.teamSyncPreview;
        await ctx.editMessageText("❌ <b>Sync preview expired.</b>\n\nGenerate a fresh preview before confirming.", { parse_mode: "HTML" }).catch(() => { });
        return;
    }

    const progressMsg = await ctx.reply("⏳ Starting Full System Sync...");
    await executeFullSync(ctx, progressMsg);
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
