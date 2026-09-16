import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { build14DayCalendar } from "../../utils/task-helpers.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { workShiftRepository } from "../../repositories/work-shift-repository.js";
import { groupRecipientsByLocation, type BulkTaskLocationGroup } from "./bulk-task-recipients.js";
import { formatStaffName } from "../../utils/task-helpers.js";
import { normalizeCity } from "./utils.js";

export const taskBulkHandlers = new Composer<MyContext>();

/**
 * Спрашивать про scope есть смысл только когда есть что сужать.
 */
export function shouldSkipScopeStep(locationCount: number): boolean {
    return locationCount <= 1;
}

/**
 * Старт мастера. Гасит состояние остальных админских флоу,
 * чтобы свободный текст не перехватил чужой обработчик.
 */
export async function startBulkTask(ctx: MyContext): Promise<void> {
    ctx.session.adminFlow = 'BULK_TASK';
    ctx.session.step = "idle";
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;

    ctx.session.bulkTaskData = { step: "SELECT_DATE", cities: [], locationIds: [], excludedStaffIds: [] };
    await renderDateSelection(ctx);
}

async function renderDateSelection(ctx: MyContext) {
    const keyboard = new InlineKeyboard();
    for (const row of build14DayCalendar("tbk_d_")) {
        keyboard.row(...row);
    }
    keyboard.row().text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-date-title"], keyboard, { pushToStack: true });
}

taskBulkHandlers.callbackQuery(/^tbk_d_(\d{4}-\d{2}-\d{2})$/, async (ctx: MyContext) => {
    if (!ctx.session.bulkTaskData) return;
    ctx.session.bulkTaskData.date = ctx.match![1]!;
    ctx.session.bulkTaskData.step = "SELECT_CITIES";
    await renderCitySelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderCitySelection(ctx: MyContext) {
    const data = ctx.session.bulkTaskData!;
    const rawCities = await locationRepository.findAllCities();
    const allCities = Array.from(new Set(rawCities.map(normalizeCity))).sort();
    const selected = new Set(data.cities || []);

    const keyboard = new InlineKeyboard();
    for (const city of allCities) {
        keyboard.text(selected.has(city) ? `✅ ${city}` : `⬜ ${city}`, `tbk_city_${city}`).row();
    }

    if (selected.size > 0) {
        keyboard.text(`${ADMIN_TEXTS["admin-bulk-continue"]} (${selected.size})`, "tbk_cities_done").row();
    }
    keyboard.text(
        selected.size === allCities.length ? ADMIN_TEXTS["admin-bulk-unselect-all"] : ADMIN_TEXTS["admin-bulk-select-all"],
        "tbk_cities_toggle_all",
    ).row();
    keyboard.text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-cities-title"], keyboard);
}

taskBulkHandlers.callbackQuery(/^tbk_city_(.+)$/, async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const city = ctx.match![1]!;
    const selected = new Set(data.cities || []);
    if (selected.has(city)) selected.delete(city);
    else selected.add(city);
    data.cities = Array.from(selected);

    await renderCitySelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_cities_toggle_all", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const rawCities = await locationRepository.findAllCities();
    const allCities = Array.from(new Set(rawCities.map(normalizeCity))).sort();
    data.cities = (data.cities || []).length === allCities.length ? [] : allCities;

    await renderCitySelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_cities_done", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    if (!data.cities || data.cities.length === 0) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["admin-bulk-err-no-cities"], show_alert: true }).catch(() => { });
        return;
    }

    const locations = await findLocationsInCities(data.cities);
    if (shouldSkipScopeStep(locations.length)) {
        data.locationIds = locations.map(l => l.id);
        data.step = "SELECT_RECIPIENTS";
        await renderRecipientSelection(ctx);
    } else {
        data.step = "SELECT_SCOPE";
        await renderScopeSelection(ctx);
    }
    await ctx.answerCallbackQuery().catch(() => { });
});

async function findLocationsInCities(cities: string[]) {
    const all = await locationRepository.findAllActive();
    return all.filter(loc => cities.includes(normalizeCity(loc.city)));
}

async function renderScopeSelection(ctx: MyContext) {
    const keyboard = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-bulk-scope-all"], "tbk_scope_all").row()
        .text(ADMIN_TEXTS["admin-bulk-scope-pick"], "tbk_scope_pick").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-scope-title"], keyboard);
}

taskBulkHandlers.callbackQuery("tbk_scope_all", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const locations = await findLocationsInCities(data.cities || []);
    data.locationIds = locations.map(l => l.id);
    data.step = "SELECT_RECIPIENTS";
    await renderRecipientSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_scope_pick", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    data.step = "SELECT_LOCATIONS";
    await renderLocationSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderLocationSelection(ctx: MyContext) {
    const data = ctx.session.bulkTaskData!;
    const locations = await findLocationsInCities(data.cities || []);
    const selected = new Set(data.locationIds || []);

    const keyboard = new InlineKeyboard();
    for (const loc of locations) {
        const label = `${normalizeCity(loc.city)} · ${loc.name}`;
        keyboard.text(selected.has(loc.id) ? `✅ ${label}` : `⬜ ${label}`, `tbk_loc_${loc.id}`).row();
    }

    if (selected.size > 0) {
        keyboard.text(`${ADMIN_TEXTS["admin-bulk-continue"]} (${selected.size})`, "tbk_locs_done").row();
    }
    keyboard.text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-locations-title"], keyboard);
}

taskBulkHandlers.callbackQuery(/^tbk_loc_(.+)$/, async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const locId = ctx.match![1]!;
    const selected = new Set(data.locationIds || []);
    if (selected.has(locId)) selected.delete(locId);
    else selected.add(locId);
    data.locationIds = Array.from(selected);

    await renderLocationSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_locs_done", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    if (!data.locationIds || data.locationIds.length === 0) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["admin-bulk-err-no-locations"], show_alert: true }).catch(() => { });
        return;
    }

    data.step = "SELECT_RECIPIENTS";
    await renderRecipientSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_cancel", async (ctx: MyContext) => {
    delete ctx.session.bulkTaskData;
    if (ctx.session.adminFlow === 'BULK_TASK') delete ctx.session.adminFlow;
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-bulk-cancelled"], "admin-system");
    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * Telegram caps an inline keyboard at ~100 buttons total. This screen puts every staff
 * member and every location header on its own row, and the Continue/Cancel rows share the
 * same budget — so the cap on staff rows alone must sit comfortably under 100, not at it.
 * Past this, Telegram rejects the whole keyboard with "reply markup is too long", which the
 * admin would otherwise see as a dead generic error screen with no indication of the cause.
 */
export const MAX_RECIPIENT_ROWS = 80;

/**
 * Считать весь бюджет клавиатуры, а не только сотрудников: каждая выбранная локация
 * добавляет строку-заголовок, поэтому 80 человек на 20 локациях — это 100 строк,
 * а не 80. Заголовки рисуются для КАЖДОЙ выбранной локации, включая пустые.
 */
export function exceedsRecipientRowLimit(groups: BulkTaskLocationGroup[]): boolean {
    const totalStaff = groups.reduce((total, group) => total + group.staff.length, 0);
    return totalStaff + groups.length > MAX_RECIPIENT_ROWS;
}

export function buildRecipientRows(
    groups: BulkTaskLocationGroup[],
    excludedStaffIds: string[],
): { text: string; callback_data: string }[][] {
    const excluded = new Set(excludedStaffIds);
    const rows: { text: string; callback_data: string }[][] = [];

    for (const group of groups) {
        const header = group.staff.length === 0
            ? `— ${group.city} · ${group.locationName} — ${ADMIN_TEXTS["admin-bulk-no-shifts"]}`
            : `— ${group.city} · ${group.locationName} —`;
        rows.push([{ text: header, callback_data: "tbk_noop" }]);

        for (const member of group.staff) {
            const mark = excluded.has(member.id) ? "⬜" : "✅";
            rows.push([{
                text: `${mark} ${formatStaffName(member.fullName)}`,
                callback_data: `tbk_staff_${member.id}`,
            }]);
        }
    }

    return rows;
}

export function countSelectedRecipients(
    groups: BulkTaskLocationGroup[],
    excludedStaffIds: string[],
): number {
    const excluded = new Set(excludedStaffIds);
    return groups.reduce(
        (total, group) => total + group.staff.filter(s => !excluded.has(s.id)).length,
        0,
    );
}

async function loadRecipientGroups(ctx: MyContext): Promise<BulkTaskLocationGroup[]> {
    const data = ctx.session.bulkTaskData!;
    const locations = await findLocationsInCities(data.cities || []);
    const chosen = locations.filter(l => (data.locationIds || []).includes(l.id));

    const shifts = await workShiftRepository.findWithShiftAtLocations(
        chosen.map(l => l.id),
        new Date(`${data.date}T00:00:00`),
    );

    return groupRecipientsByLocation(
        shifts,
        chosen.map(l => ({ id: l.id, city: normalizeCity(l.city), name: l.name })),
    );
}

async function renderRecipientSelection(ctx: MyContext): Promise<void> {
    const data = ctx.session.bulkTaskData!;
    const groups = await loadRecipientGroups(ctx);

    if (exceedsRecipientRowLimit(groups)) {
        const totalStaff = groups.reduce((total, group) => total + group.staff.length, 0);
        const keyboard = new InlineKeyboard()
            .text(ADMIN_TEXTS["admin-btn-back"], "tbk_scope_pick").row()
            .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

        await ScreenManager.renderScreen(
            ctx,
            ADMIN_TEXTS["admin-bulk-err-too-many"].replace("{count}", String(totalStaff)),
            keyboard,
        );
        return;
    }

    const excluded = data.excludedStaffIds || [];
    const selectedCount = countSelectedRecipients(groups, excluded);

    const keyboard = new InlineKeyboard();
    for (const row of buildRecipientRows(groups, excluded)) {
        keyboard.row(...row);
    }

    if (selectedCount > 0) {
        keyboard.row().text(`${ADMIN_TEXTS["admin-bulk-continue"]} (${selectedCount})`, "tbk_recipients_done");
    }
    keyboard.row().text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-recipients-title"], keyboard);
}

taskBulkHandlers.callbackQuery("tbk_noop", async (ctx: MyContext) => {
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery(/^tbk_staff_(.+)$/, async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const staffId = ctx.match![1]!;
    const excluded = new Set(data.excludedStaffIds || []);
    if (excluded.has(staffId)) excluded.delete(staffId);
    else excluded.add(staffId);
    data.excludedStaffIds = Array.from(excluded);

    await renderRecipientSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

taskBulkHandlers.callbackQuery("tbk_recipients_done", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const groups = await loadRecipientGroups(ctx);
    if (countSelectedRecipients(groups, data.excludedStaffIds || []) === 0) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["admin-bulk-err-no-recipients"], show_alert: true }).catch(() => { });
        return;
    }

    data.step = "SELECT_MODE";
    await renderModeSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

// renderModeSelection реализуется в Task 7.
async function renderModeSelection(_ctx: MyContext): Promise<void> {
    throw new Error("renderModeSelection is implemented in Task 7");
}
