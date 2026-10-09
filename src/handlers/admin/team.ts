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
import { escapeHtml, formatLocation, normalizeCity } from "./utils.js";
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
import { getShiftTimeFromOpeningHours, type OpeningHoursDay } from "../../utils/location-opening-hours.js";

function formatShiftClock(date: Date) {
    return date.toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Kyiv"
    });
}

/** Same source order as the staff view: shift times, then canonical hours, then legacy text. */
function formatScheduleNotificationShiftTime(shift: {
    date: Date;
    startTime?: Date | null;
    endTime?: Date | null;
    location?: { schedule?: string | null; openingHours?: OpeningHoursDay[] | null } | null;
}) {
    if (shift.startTime && shift.endTime) {
        return `${formatShiftClock(shift.startTime)}-${formatShiftClock(shift.endTime)}`;
    }

    return getShiftTimeFromOpeningHours(shift.location?.openingHours, shift.date)
        || getShiftTimeFromLocationSchedule(shift.location?.schedule, shift.date)
        || "time not set";
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
    await ctx.answerCallbackQuery().catch(() => { });
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
        ctx.session.step = "idle";
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.bulkTaskData;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.manualChannelAccess;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;
        await ScreenManager.renderScreen(ctx, "📅 <b>Schedule</b>", "admin-schedule-dates", { pushToStack: true });
    }).row();

    range.text("🏢 Locations", async (ctx) => {
        ctx.session.adminFlow = 'LOCATIONS';
        ctx.session.step = "idle";
        delete ctx.session.selectedDate;
        delete ctx.session.selectedLocationId;
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.bulkTaskData;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.manualChannelAccess;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;
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

        range.text("📂 Custom Sync", async (ctx) => {
            ctx.session.adminFlow = "SCHEDULE";
            ctx.session.step = "sync_other_sheet";
            delete ctx.session.taskData;
            delete ctx.session.taskCreation;
            delete ctx.session.bulkTaskData;
            delete ctx.session.broadcastData;
            delete ctx.session.broadcastDraft;
            delete ctx.session.manualChannelAccess;
            delete ctx.session.supportData?.step;
            delete ctx.session.supportData?.replyingToUserId;
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
            await ctx.answerCallbackQuery({ text: "No access.", show_alert: true }).catch(() => { });
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

    const requests = await replacementService.listManageableRequestsForAdmin();
    const kb = new InlineKeyboard();

    requests.slice(0, 8).forEach((request, index) => {
        if (request.status === "FOUND") {
            kb.text(
                ADMIN_TEXTS["admin-replacement-cancel-confirmed-button"]({ index: index + 1 }),
                `admin_repl_review_cancel_${request.id}`
            ).danger().row();
            return;
        }

        kb.text(
            ADMIN_TEXTS["admin-replacement-cancel-search-button"]({ index: index + 1 }),
            `admin_repl_cancel_${request.id}`
        ).danger().row();
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

async function showAdminConfirmedReplacementCancel(ctx: MyContext, requestId: string) {
    if (!(await ensureMainAdmin(ctx))) return;

    const request = await replacementService.getConfirmedRequestForAdmin(requestId);
    if (!request?.replacement) {
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-replacement-cancel-confirmed-inactive"]).catch(() => { });
        await showAdminReplacementBoard(ctx, true);
        return;
    }

    const date = request.shiftDate.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "Europe/Kyiv"
    });
    const time = formatScheduleNotificationShiftTime({
        date: request.shiftDate,
        startTime: request.shiftStartTime,
        endTime: request.shiftEndTime,
        location: request.location
    });
    const requester = request.requester?.fullName || "empty shift";

    const text = ADMIN_TEXTS["admin-replacement-cancel-confirmed-text"]({
        date: escapeHtml(date),
        time: escapeHtml(time),
        location: escapeHtml(request.location.name),
        requester: escapeHtml(requester),
        replacement: escapeHtml(request.replacement.fullName)
    });
    const kb = new InlineKeyboard()
        .text(
            ADMIN_TEXTS["admin-replacement-cancel-confirmed-confirm"],
            `admin_repl_do_cancel_found_${request.id}`
        ).danger().row()
        .text(ADMIN_TEXTS["admin-btn-back"], "admin_repl_board");

    await ScreenManager.renderScreen(ctx, text, kb, { forceNew: true, pushToStack: true });
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
        kb.text(formatLocation(location, "in-city"), `admin_repl_loc_${location.id}`).row();
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
        `➕ <b>Manual replacement search</b>\n\nLocation: <b>${escapeHtml(formatLocation(location, "sentence"))}</b>\n${body}`,
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
        .text("✖️ Cancel", "admin_repl_board").danger();

    await ScreenManager.renderScreen(
        ctx,
        `➕ <b>Start manual replacement search?</b>\n\n` +
        `📍 <b>${escapeHtml(formatLocation({ name: draft.locationName, city: draft.city }, "sentence"))}</b>\n` +
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
        await ctx.answerCallbackQuery({ text: message, show_alert: true }).catch(() => { });
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

adminTeamHandlers.callbackQuery(/^admin_repl_review_cancel_(.+)$/, async (ctx) => {
    await showAdminConfirmedReplacementCancel(ctx, ctx.match![1]!);
});

adminTeamHandlers.callbackQuery(/^admin_repl_do_cancel_found_(.+)$/, async (ctx) => {
    if (!(await ensureMainAdmin(ctx))) return;

    const requestId = ctx.match![1]!;
    const result = await replacementService.cancelConfirmedRequestByAdmin(ctx.api, requestId);
    const message = result === "cancelled"
        ? ADMIN_TEXTS["admin-replacement-cancel-confirmed-success"]
        : result === "replacement_still_scheduled"
            ? ADMIN_TEXTS["admin-replacement-cancel-confirmed-still-scheduled"]
            : ADMIN_TEXTS["admin-replacement-cancel-confirmed-inactive"];

    await ctx.answerCallbackQuery(
        result === "replacement_still_scheduled"
            ? { text: message, show_alert: true }
            : message
    ).catch(() => { });
    audit({
        event: "replacement_confirmed_admin_cancelled",
        result: result === "cancelled" ? "success" : "failed",
        actorType: "admin",
        telegramId: ctx.from?.id,
        entityType: "replacement_request",
        entityId: requestId,
        context: { reason: result }
    });
    await showAdminReplacementBoard(ctx, true);
});

adminTeamHandlers.callbackQuery("back_to_schedule_dates", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => { });
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
        range.text(formatLocation({ ...l, city }, "in-city"), async (ctx) => {
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
        range.text("📭 No shifts", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-shifts-none"]).catch(() => { })).row();
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
        range.text(formatLocation({ ...l, city }, "in-city"), async (ctx) => {
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
        range.text("📭 No staff here", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-staff-none-loc"]).catch(() => { })).row();
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
