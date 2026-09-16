import { Composer, InlineKeyboard } from "grammy";
import { TaskCompletionMode } from "@prisma/client";
import type { MyContext } from "../../types/context.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { build14DayCalendar } from "../../utils/task-helpers.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { workShiftRepository } from "../../repositories/work-shift-repository.js";
import { groupRecipientsByLocation, type BulkTaskLocationGroup } from "./bulk-task-recipients.js";
import { formatStaffName } from "../../utils/task-helpers.js";
import { normalizeCity, getMessageHtml } from "./utils.js";
import { TASK_TEXT_MAX_LENGTH } from "../../services/task-service.js";

export const taskBulkHandlers = new Composer<MyContext>();

/**
 * Telegram отвергает сообщения длиннее 4096 символов. Сводка подтверждения
 * склеивает текст задачи (до TASK_TEXT_MAX_LENGTH, включая HTML-разметку) с
 * неограниченной построчной разбивкой по локациям — при большом числе локаций
 * с длинными названиями лимит превышается даже при коротком тексте задачи.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

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

async function renderModeSelection(ctx: MyContext): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-bulk-mode-proof"], "tbk_mode_proof").row()
        .text(ADMIN_TEXTS["admin-bulk-mode-quick"], "tbk_mode_quick").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-mode-title"], keyboard);
}

taskBulkHandlers.callbackQuery(/^tbk_mode_(proof|quick)$/, async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    data.completionMode = ctx.match![1] === "proof"
        ? TaskCompletionMode.PROOF_REQUIRED
        : TaskCompletionMode.QUICK;
    data.step = "AWAITING_TEXT";

    const keyboard = new InlineKeyboard().text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-text-title"], keyboard);
    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * Приём свободного текста и ручного времени дедлайна. Вызывается из общего
 * message-funnel в admin/index.ts, следом за handleBroadcastContent.
 * Возвращает true, если сообщение поглощено этим флоу.
 */
export async function handleBulkTaskContent(ctx: MyContext): Promise<boolean> {
    const data = ctx.session.bulkTaskData;
    if (!data) return false;
    if (ctx.session.adminFlow !== 'BULK_TASK') return false;
    if (data.step !== "AWAITING_TEXT" && data.step !== "SELECT_DEADLINE") return false;
    if (ctx.chat?.type !== "private") return false;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    if (!hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT')) return false;

    const message = ctx.message;
    if (!message) return false;

    if (data.step === "SELECT_DEADLINE" && message.text) {
        const timeInput = message.text.trim();
        if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(timeInput)) {
            data.deadlineTime = timeInput;
            data.step = "CONFIRM";
            await ctx.deleteMessage().catch(() => { });
            await renderConfirmation(ctx);
        } else {
            await ctx.reply(ADMIN_TEXTS["admin-bulk-err-bad-time"]);
        }
        return true;
    }

    if (data.step !== "AWAITING_TEXT") return false;

    const html = getMessageHtml(message);
    if (!html || html.trim().length === 0) return true;

    if (html.length > TASK_TEXT_MAX_LENGTH) {
        await ctx.reply(ADMIN_TEXTS["admin-bulk-err-text-too-long"]);
        return true;
    }

    data.taskText = html;
    if (message.photo?.length) {
        data.fileId = message.photo[message.photo.length - 1]!.file_id;
        data.mediaType = "photo";
    } else if (message.document) {
        data.fileId = message.document.file_id;
        data.mediaType = "document";
    }

    data.step = "SELECT_DEADLINE";
    await ctx.deleteMessage().catch(() => { });
    await renderDeadlineSelection(ctx);
    return true;
}

async function renderDeadlineSelection(ctx: MyContext): Promise<void> {
    const keyboard = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-bulk-deadline-eod"], "tbk_time_23:59")
        .text(ADMIN_TEXTS["admin-bulk-deadline-none"], "tbk_time_none").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-deadline-title"], keyboard);
}

taskBulkHandlers.callbackQuery(/^tbk_time_(.+)$/, async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const raw = ctx.match![1]!;
    data.deadlineTime = raw === "none" ? null : raw;
    data.step = "CONFIRM";
    await renderConfirmation(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

export function buildConfirmationSummary(
    groups: BulkTaskLocationGroup[],
    excludedStaffIds: string[],
    params: { date: string; deadlineTime: string | null; completionMode: string; taskText: string },
): string {
    const excluded = new Set(excludedStaffIds);
    const perLocation = groups
        .map(g => ({ label: `${g.city} · ${g.locationName}`, count: g.staff.filter(s => !excluded.has(s.id)).length }))
        .filter(entry => entry.count > 0);

    const staffTotal = perLocation.reduce((sum, entry) => sum + entry.count, 0);
    const locationTotal = perLocation.length;

    const locationWord = locationTotal === 1 ? "location" : "locations";
    const modeLabel = params.completionMode === "PROOF_REQUIRED" ? "With proof" : "Quick";
    const deadlineLabel = params.deadlineTime ? `by ${params.deadlineTime}` : "No deadline";

    const breakdown = perLocation.map(entry => `• ${entry.label}: ${entry.count}`).join("\n");

    return [
        `📋 <b>Bulk task review</b>`,
        ``,
        params.taskText,
        ``,
        `📅 ${params.date} — ${deadlineLabel}`,
        `⚙️ ${modeLabel}`,
        ``,
        `👥 <b>${staffTotal} staff · ${locationTotal} ${locationWord}</b>`,
        breakdown,
    ].join("\n");
}

async function renderConfirmation(ctx: MyContext): Promise<void> {
    const data = ctx.session.bulkTaskData!;
    const groups = await loadRecipientGroups(ctx);

    const summary = buildConfirmationSummary(groups, data.excludedStaffIds || [], {
        date: data.date!,
        deadlineTime: data.deadlineTime ?? null,
        completionMode: data.completionMode ?? TaskCompletionMode.QUICK,
        taskText: data.taskText || "",
    });

    if (summary.length > TELEGRAM_MESSAGE_LIMIT) {
        data.step = "AWAITING_TEXT";
        await ctx.reply(ADMIN_TEXTS["admin-bulk-err-summary-too-long"]);
        return;
    }

    const keyboard = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-bulk-confirm-send"], "tbk_send").row()
        .text(ADMIN_TEXTS["admin-bulk-restart"], "tbk_restart")
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, summary, keyboard);
}

taskBulkHandlers.callbackQuery("tbk_restart", async (ctx: MyContext) => {
    await startBulkTask(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});
