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
import { formatLocation, normalizeCity } from "./utils.js";
import { getCtxAdminRole } from "../../middleware/role-check.js";
import { chatLogRepository } from "../../repositories/chat-log-repository.js";
import { userRepository } from "../../repositories/user-repository.js";
import { startAdminStaffSearch } from "./search.js";
import { InputFile } from "grammy";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";

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
    range.row().text("Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Team</b>", "admin-team-ops");
    });
});

async function showBirthdayMenu(ctx: MyContext) {
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bday-header-all"] + "\n\n" + ADMIN_TEXTS["admin-bday-select-month"], "admin-birthdays", { pushToStack: true });
}

export async function handleBirthdayMonthCallback(ctx: MyContext, month: number) {
    const text = await getBirthdaysByMonth(month === 0 ? undefined : month);
    const kb = new InlineKeyboard().text("Back", "admin_birthdays_back");
    await ctx.answerCallbackQuery().catch(() => { });
    await ScreenManager.renderScreen(ctx, text, kb, {
        pushToStack: true,
        manualMenuId: "admin-birthday-list"
    });
}

// --- 1. TEAM & OPS MENU ---
export const adminTeamOpsMenu = new Menu<MyContext>("admin-team-ops");
adminTeamOpsMenu.dynamic(async (ctx, range) => {
    const userRole = await getCtxAdminRole(ctx);

    range.text("Schedule", async (ctx) => {
        ctx.session.adminFlow = 'SCHEDULE';
        ctx.session.step = "idle";
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.bulkTaskData;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;
        await ScreenManager.renderScreen(ctx, "<b>Schedule</b>", "admin-schedule-dates", { pushToStack: true });
    });

    range.text("Locations", async (ctx) => {
        ctx.session.adminFlow = 'LOCATIONS';
        ctx.session.step = "idle";
        delete ctx.session.selectedDate;
        delete ctx.session.selectedLocationId;
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.bulkTaskData;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;
        await ScreenManager.renderScreen(ctx, "<b>Locations</b>", "admin-team-cities", { pushToStack: true });
    }).row();

    range.text("Staff Search", async (ctx) => {
        ctx.session.adminFlow = 'SEARCH';
        delete ctx.session.selectedDate;
        delete ctx.session.selectedLocationId;
        delete ctx.session.taskData;
        delete ctx.session.broadcastData;
        await startAdminStaffSearch(ctx);
    });

    if (userRole !== 'SUPPORT') {
        range.text("Birthdays", async (ctx) => {
            await showBirthdayMenu(ctx);
        });
    }
    range.row();

    range.text("Back", async (ctx) => {
        const userRole = await getCtxAdminRole(ctx);
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

// Кнопки Channel / Custom Sync со старых сообщений ("admin-channel/...") гасит
// тихий обработчик в system.ts.

// --- NEW SCHEDULE FLOW ---
export const adminScheduleDateMenu = new Menu<MyContext>("admin-schedule-dates");
adminScheduleDateMenu.dynamic(async (ctx, range) => {
    // 1. Static buttons first (Today, Tomorrow, History)
    range.text("Today", async (ctx) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        ctx.session.selectedDate = d.toISOString();
        await ScreenManager.renderScreen(ctx, "<b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
    });
    range.text("Tomorrow", async (ctx) => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        ctx.session.selectedDate = d.toISOString();
        await ScreenManager.renderScreen(ctx, "<b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
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
            await ScreenManager.renderScreen(ctx, "<b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
        });
        // Row every 3 buttons
        if ((i - 2 + 1) % 3 === 0) range.row();
    }

    // Ensure row before Back
    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Team</b>", "admin-team-ops");
    });
});

export const adminTeamHandlers = new Composer<MyContext>();

// «Find Gaps» и доска «Replacement Searches» убраны 28.10.2026: владелец ими не пользуется,
// подмены ведутся в вебаппе. Кнопки со старых сообщений отвечают тихо и ничего не делают.
adminTeamHandlers.callbackQuery(/^admin_repl_/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "This screen is no longer available." }).catch(() => { });
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
            await ScreenManager.renderScreen(ctx, "<b>Select City:</b>", "admin-schedule-cities", { pushToStack: true });
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
            await ScreenManager.renderScreen(ctx, `<b>Select Location in ${normalizeCity(city)}:</b>`, "admin-schedule-locations", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Select Date:</b>", "admin-schedule-dates");
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
            await ScreenManager.renderScreen(ctx, "<b>Select Staff:</b>", "admin-schedule-staff", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Select City:</b>", "admin-schedule-cities");
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
        range.text("No shifts", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-shifts-none"]).catch(() => { })).row();
    } else {
        const staffMap = new Map<string, any>();
        shifts.forEach((s: any) => staffMap.set(s.staff.id, s.staff));
        const uniqueStaff = Array.from(staffMap.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));

        uniqueStaff.forEach((staff: any) => {
            range.text(`${staffService.shortenName(staff.fullName)}`, async (ctx) => {
                ctx.session.selectedUserId = staff.userId;
                const profile = staff;
                const viewerRole = ctx.from?.id ? await getCtxAdminRole(ctx) : null;
                const text = (await staffService.getProfileText(profile, false, viewerRole)) + `\n${ADMIN_TEXTS["admin-profile-select-action"]}`;

                const kb = new InlineKeyboard()
                    .text("Write Message", `admin_send_msg_${staff.userId}`).row()
                    .text("Set Task", `admin_send_task_${staff.userId}`).row();

                if (viewerRole === "SUPER_ADMIN") {
                    kb.text("Chat History", `admin_timeline_export_${staff.userId}`).row();
                }
                kb.text(ADMIN_TEXTS["admin-btn-back"], "back_to_schedule_staff");
                await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
            }).row();
        });
    }
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Select Location:</b>", "admin-schedule-locations");
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
            await ScreenManager.renderScreen(ctx, `<b>Select Location in ${normalizeCity(city)}:</b>`, "admin-team-locations", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Team</b>", "admin-team-ops");
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
            await ScreenManager.renderScreen(ctx, "<b>Select Staff:</b>", "admin-location-staff", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Select City:</b>", "admin-team-cities");
    });
});

export const adminLocationStaffMenu = new Menu<MyContext>("admin-location-staff");
adminLocationStaffMenu.dynamic(async (ctx, range) => {
    const locId = ctx.session.selectedLocationId;
    if (!locId) return;

    const staff = (await staffRepository.findByLocation(locId))
        .sort((a: any, b: any) => a.fullName.localeCompare(b.fullName));

    if (staff.length === 0) {
        range.text("No staff here", (ctx) => ctx.answerCallbackQuery(ADMIN_TEXTS["admin-staff-none-loc"]).catch(() => { })).row();
    } else {
        staff.forEach((s: any) => {
            range.text(`${staffService.shortenName(s.fullName)}`, async (ctx) => {
                ctx.session.selectedUserId = s.userId;
                const viewerRole = ctx.from?.id ? await getCtxAdminRole(ctx) : null;
                const text = (await staffService.getProfileText(s, false, viewerRole)) + `\n${ADMIN_TEXTS["admin-profile-select-action"]}`;

                const kb = new InlineKeyboard()
                    .text("Write Message", `admin_send_msg_${s.userId}`).row()
                    .text("Set Task", `admin_send_task_${s.userId}`).row();

                if (viewerRole === "SUPER_ADMIN") {
                    kb.text("Chat History", `admin_timeline_export_${s.userId}`).row();
                }
                kb.text(ADMIN_TEXTS["admin-btn-back"], "back_to_loc_staff");
                await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
            }).row();
        });
    }
    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await ScreenManager.goBack(ctx, "<b>Select Location:</b>", "admin-team-locations");
    });
});
