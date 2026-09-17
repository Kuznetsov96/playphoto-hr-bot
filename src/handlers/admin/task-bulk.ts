import { Composer, InlineKeyboard } from "grammy";
import { TaskCompletionMode } from "@prisma/client";
import type { MyContext, TaskAttachmentItem } from "../../types/context.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { build14DayCalendar } from "../../utils/task-helpers.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { workShiftRepository } from "../../repositories/work-shift-repository.js";
import { groupRecipientsByLocation, type BulkTaskLocationGroup } from "./bulk-task-recipients.js";
import { formatStaffName } from "../../utils/task-helpers.js";
import { normalizeCity, getMessageHtml, sendTaskNotification, escapeHtml } from "./utils.js";
import { formatLocation } from "../../utils/location-label.js";
import { taskService, TASK_TEXT_MAX_LENGTH, type BulkTaskCreationResult } from "../../services/task-service.js";
import { TELEGRAM_MESSAGE_LIMIT } from "../../constants/telegram-limits.js";
import { isValidTaskDeadlineTime } from "../../utils/task-time.js";
import { buildTaskNotificationText, TASK_NOTIFICATION_BUTTON_CALLBACK, taskNotificationButtonLabel } from "../../utils/task-notification.js";

export const taskBulkHandlers = new Composer<MyContext>();

/**
 * Telegram отвергает сообщения длиннее 4096 символов (TELEGRAM_MESSAGE_LIMIT,
 * см. constants/telegram-limits.ts). Сводка подтверждения склеивает текст
 * задачи (до TASK_TEXT_MAX_LENGTH, включая HTML-разметку) с неограниченной
 * построчной разбивкой по локациям — при большом числе локаций с длинными
 * названиями лимит превышается даже при коротком тексте задачи.
 */
export { TELEGRAM_MESSAGE_LIMIT };

/**
 * Спрашивать про scope есть смысл только когда есть что сужать.
 */
export function shouldSkipScopeStep(locationCount: number): boolean {
    return locationCount <= 1;
}

/**
 * "Слишком много получателей" — тупик, если единственный выход с экрана
 * ведёт назад к выбору локаций, а сузить нечем: при одной локации (или без
 * scope-шага вовсе) назад приводит на тот же результат. Совпадает с условием
 * shouldSkipScopeStep не случайно — это один и тот же факт "sub-location
 * narrowing доступен", проверяемый в двух разных местах мастера.
 */
export function canNarrowByLocation(locationCount: number): boolean {
    return !shouldSkipScopeStep(locationCount);
}

export type BulkTaskStep = NonNullable<MyContext["session"]["bulkTaskData"]>["step"];

/**
 * Куда ведёт Back с данного шага — чистая функция без побочных эффектов,
 * поэтому она тестируема без сессии, ScreenManager и сети.
 *
 * `locationCount` — число локаций в уже выбранных городах: тот же факт, что
 * решает shouldSkipScopeStep/canNarrowByLocation. Назад с SELECT_RECIPIENTS
 * обязан учитывать его же — если экран SELECT_SCOPE был пропущен на пути
 * вперёд (одна локация), Back не имеет права показать админу экран, которого
 * тот никогда не видел.
 *
 * Возвращает null для SELECT_DATE (первый шаг — уходить некуда, только
 * Cancel) и для SENDING (переходного состояния, из которого Back не
 * вызывается).
 */
export function previousStep(
    step: BulkTaskStep,
    context: { locationCount: number },
): BulkTaskStep | null {
    switch (step) {
        case "SELECT_DATE":
            return null;
        case "SELECT_CITIES":
            return "SELECT_DATE";
        case "SELECT_SCOPE":
            return "SELECT_CITIES";
        case "SELECT_LOCATIONS":
            return "SELECT_SCOPE";
        case "SELECT_RECIPIENTS":
            return shouldSkipScopeStep(context.locationCount) ? "SELECT_CITIES" : "SELECT_SCOPE";
        case "SELECT_MODE":
            return "SELECT_RECIPIENTS";
        case "AWAITING_TEXT":
            return "SELECT_MODE";
        case "SELECT_DEADLINE":
            return "AWAITING_TEXT";
        case "CONFIRM":
            return "SELECT_DEADLINE";
        case "SENDING":
            return null;
        default:
            return null;
    }
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

/**
 * Выход с тупикового экрана «слишком много получателей», когда сузить
 * некуда (одна локация без scope-шага): дата — единственное, что реально
 * меняет число получателей, если локация уже одна.
 */
taskBulkHandlers.callbackQuery("tbk_back_to_date", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    data.step = "SELECT_DATE";
    await renderDateSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function getAllBulkTaskCities(): Promise<string[]> {
    const rawCities = await locationRepository.findAllCities();
    return Array.from(new Set(rawCities.map(normalizeCity))).sort();
}

/**
 * `allCities` is optional so a caller that already computed it (e.g. the toggle-all
 * handler, which needs the list to decide what "all" means) doesn't make grammY's menu
 * rebuild fetch it a second time for the same tap.
 */
async function renderCitySelection(ctx: MyContext, allCities?: string[]) {
    const data = ctx.session.bulkTaskData!;
    const cities = allCities ?? await getAllBulkTaskCities();
    const selected = new Set(data.cities || []);

    const keyboard = new InlineKeyboard();
    for (const city of cities) {
        keyboard.text(selected.has(city) ? `✅ ${city}` : `⬜ ${city}`, `tbk_city_${city}`).row();
    }

    if (selected.size > 0) {
        keyboard.text(`${ADMIN_TEXTS["admin-bulk-continue"]} (${selected.size})`, "tbk_cities_done").row();
    }
    keyboard.text(
        selected.size === cities.length ? ADMIN_TEXTS["admin-bulk-unselect-all"] : ADMIN_TEXTS["admin-bulk-select-all"],
        "tbk_cities_toggle_all",
    ).row();
    keyboard.text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row();
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

    const allCities = await getAllBulkTaskCities();
    data.cities = (data.cities || []).length === allCities.length ? [] : allCities;

    await renderCitySelection(ctx, allCities);
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
        .text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-bulk-scope-title"], keyboard);
}

taskBulkHandlers.callbackQuery("tbk_scope_all", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    const locations = await findLocationsInCities(data.cities || []);
    data.locationIds = locations.map(l => l.id);
    data.step = "SELECT_RECIPIENTS";
    await renderRecipientSelection(ctx, locations);
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
        const label = formatLocation(loc, "listing");
        keyboard.text(selected.has(loc.id) ? `✅ ${label}` : `⬜ ${label}`, `tbk_loc_${loc.id}`).row();
    }

    if (selected.size > 0) {
        keyboard.text(`${ADMIN_TEXTS["admin-bulk-continue"]} (${selected.size})`, "tbk_locs_done").row();
    }
    keyboard.text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row();
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
            ? `— ${group.label} — ${ADMIN_TEXTS["admin-bulk-no-shifts"]}`
            : `— ${group.label} —`;
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

/**
 * `activeLocations` is optional so a caller that already resolved the active locations for
 * the chosen cities (e.g. `tbk_scope_all`, which needs that list to decide what "all" means)
 * doesn't make `findLocationsInCities` re-run `locationRepository.findAllActive()` for the
 * same tap.
 */
async function loadRecipientGroups(ctx: MyContext, activeLocations?: Awaited<ReturnType<typeof findLocationsInCities>>): Promise<BulkTaskLocationGroup[]> {
    const data = ctx.session.bulkTaskData!;
    const locations = activeLocations ?? await findLocationsInCities(data.cities || []);
    const chosen = locations.filter(l => (data.locationIds || []).includes(l.id));

    const shifts = await workShiftRepository.findWithShiftAtLocations(
        chosen.map(l => l.id),
        new Date(`${data.date}T00:00:00`),
    );

    return groupRecipientsByLocation(
        shifts,
        chosen.map(l => ({
            id: l.id,
            city: normalizeCity(l.city),
            name: l.name,
            label: formatLocation(l, "listing"),
        })),
    );
}

async function renderRecipientSelection(ctx: MyContext, activeLocations?: Awaited<ReturnType<typeof findLocationsInCities>>): Promise<void> {
    const data = ctx.session.bulkTaskData!;
    const groups = await loadRecipientGroups(ctx, activeLocations);

    if (exceedsRecipientRowLimit(groups)) {
        const totalStaff = groups.reduce((total, group) => total + group.staff.length, 0);
        const canNarrow = canNarrowByLocation((data.locationIds || []).length);

        const keyboard = new InlineKeyboard();
        if (canNarrow) {
            keyboard.text(ADMIN_TEXTS["admin-btn-back"], "tbk_scope_pick").row();
        } else {
            keyboard.text(ADMIN_TEXTS["admin-bulk-back-to-date"], "tbk_back_to_date").row();
        }
        keyboard.text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");
        // Эти два дедэнда — не обычный шаг мастера, поэтому не участвуют в
        // общей tbk_back/previousStep логике: у них уже есть собственный,
        // более точный выход (сузить локации или сменить дату).

        const message = canNarrow
            ? ADMIN_TEXTS["admin-bulk-err-too-many"]
            : ADMIN_TEXTS["admin-bulk-err-too-many-single-location"];

        await ScreenManager.renderScreen(
            ctx,
            message.replace("{count}", String(totalStaff)),
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
    keyboard.row().text(ADMIN_TEXTS["admin-btn-back"], "tbk_back");
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
        .text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row()
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

    await renderTextStep(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * Общий рендер для AWAITING_TEXT — используется как при движении вперёд (после
 * выбора режима), так и при Back с шага дедлайна. В обоих случаях уже введённый
 * текст (если есть) не стирается: админ его правит, а не перепечатывает.
 */
async function renderTextStep(ctx: MyContext): Promise<void> {
    const data = ctx.session.bulkTaskData!;
    const keyboard = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    const title = data.taskText
        ? `${ADMIN_TEXTS["admin-bulk-text-title"]}\n\n<i>${ADMIN_TEXTS["admin-bulk-text-current"]}</i>\n${data.taskText}`
        : ADMIN_TEXTS["admin-bulk-text-title"];

    await ScreenManager.renderScreen(ctx, title, keyboard);
}

/**
 * Divergence D з аудиту вирівнювання майстрів постановки задач: bulk-флоу
 * розпізнавав лише photo і document, тоді як task-creation.ts і task-flow.ts
 * приймали усі 7 типів з `TaskAttachmentItem["type"]`. Адмін, що прикріпив
 * voice/video/video_note/audio/animation до масового завдання, втрачав його
 * без жодного попередження.
 *
 * Приймає підмножину полів grammY-повідомлення, яка тут потрібна — не саме
 * повідомлення, щоб функцію можна було протестувати без побудови повного
 * grammY Context.
 */
export function extractBulkTaskMedia(message: {
    photo?: { file_id: string }[];
    document?: { file_id: string };
    video?: { file_id: string };
    voice?: { file_id: string };
    video_note?: { file_id: string };
    audio?: { file_id: string };
    animation?: { file_id: string };
}): { fileId: string; mediaType: TaskAttachmentItem["type"] } | null {
    if (message.photo?.length) return { fileId: message.photo[message.photo.length - 1]!.file_id, mediaType: "photo" };
    if (message.document) return { fileId: message.document.file_id, mediaType: "document" };
    if (message.video) return { fileId: message.video.file_id, mediaType: "video" };
    if (message.voice) return { fileId: message.voice.file_id, mediaType: "voice" };
    if (message.video_note) return { fileId: message.video_note.file_id, mediaType: "video_note" };
    if (message.audio) return { fileId: message.audio.file_id, mediaType: "audio" };
    if (message.animation) return { fileId: message.animation.file_id, mediaType: "animation" };
    return null;
}

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
        if (isValidTaskDeadlineTime(timeInput)) {
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
    const media = extractBulkTaskMedia(message);
    if (media) {
        data.fileId = media.fileId;
        data.mediaType = media.mediaType;
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
        .text(ADMIN_TEXTS["admin-btn-back"], "tbk_back").row()
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
        .map(g => ({ label: g.label, count: g.staff.filter(s => !excluded.has(s.id)).length }))
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
        .text(ADMIN_TEXTS["admin-btn-back"], "tbk_back")
        .text(ADMIN_TEXTS["admin-bulk-restart"], "tbk_restart").row()
        .text(ADMIN_TEXTS["admin-bulk-cancel"], "tbk_cancel");

    await ScreenManager.renderScreen(ctx, summary, keyboard);
}

taskBulkHandlers.callbackQuery("tbk_restart", async (ctx: MyContext) => {
    await startBulkTask(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * Единая точка Back для всех шагов мастера, кроме SELECT_DATE (там кнопки
 * Back нет вовсе — это первый экран). Решение "куда" принимает чистая
 * previousStep(); здесь только рендер выбранного экрана с состоянием,
 * которое уже лежит в data (previousStep ничего не мутирует).
 *
 * `locationCount` считается по текущим data.cities — тем же способом, каким
 * его считает шаг SELECT_CITIES→SELECT_SCOPE/RECIPIENTS на пути вперёд, так
 * что назад с SELECT_RECIPIENTS воспроизводит то самое решение "был ли
 * scope-шаг пропущен", а не гадает по данным, которые могли не относиться к
 * тому переходу.
 */
taskBulkHandlers.callbackQuery("tbk_back", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data || !data.step) return;

    const locations = await findLocationsInCities(data.cities || []);
    const target = previousStep(data.step, { locationCount: locations.length });

    if (!target) {
        await ctx.answerCallbackQuery().catch(() => { });
        return;
    }

    data.step = target;

    switch (target) {
        case "SELECT_DATE":
            await renderDateSelection(ctx);
            break;
        case "SELECT_CITIES":
            await renderCitySelection(ctx);
            break;
        case "SELECT_SCOPE":
            await renderScopeSelection(ctx);
            break;
        case "SELECT_LOCATIONS":
            await renderLocationSelection(ctx);
            break;
        case "SELECT_RECIPIENTS":
            await renderRecipientSelection(ctx, locations);
            break;
        case "SELECT_MODE":
            await renderModeSelection(ctx);
            break;
        case "AWAITING_TEXT":
            await renderTextStep(ctx);
            break;
        case "SELECT_DEADLINE":
            await renderDeadlineSelection(ctx);
            break;
        case "CONFIRM":
            await renderConfirmation(ctx);
            break;
    }

    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * Отчёт показывает ФАКТИЧЕСКОЕ число созданных задач, а не число выбранных
 * сотрудников — и отдельно две разные проблемы: задача не создалась (сбой
 * createTasksBulk) и задача создалась, но уведомление не дошло (нет
 * telegramId или бот заблокирован). Это разные причины, требующие разных
 * действий от админа, поэтому их нельзя схлопывать в одну цифру.
 *
 * Экранирование ошибок обязательно: createTasksBulk кладёт в failed[].error
 * message исключения как есть, а он может быть сырым ZodError (многострочный
 * JSON с угловыми скобками в issue.path/expected). Рендер отчёта идёт с
 * parse_mode HTML — один неэкранированный "<" ломает Telegram-парсинг ВСЕГО
 * сообщения, и админ не увидит отчёт вовсе, хотя задачи уже создались
 * необратимо. Поэтому текст ошибки экранируется и обрезается до короткой
 * читаемой строки.
 */
const RESULT_ERROR_MAX_LENGTH = 160;

function formatResultError(error: string): string {
    const truncated = error.length > RESULT_ERROR_MAX_LENGTH
        ? `${error.slice(0, RESULT_ERROR_MAX_LENGTH)}…`
        : error;
    return escapeHtml(truncated);
}

export function buildResultReport(
    result: BulkTaskCreationResult,
    notifyFailures: string[],
    nameByStaffId: Map<string, string>,
): string {
    const header = result.created.length === 0
        ? ADMIN_TEXTS["admin-bulk-result-failed"]
        : result.failed.length > 0
            ? ADMIN_TEXTS["admin-bulk-result-partial"]
            : ADMIN_TEXTS["admin-bulk-result-done"];
    const lines = [`${header} — ${result.created.length} task(s) created.</b>`];

    if (result.failed.length > 0) {
        lines.push("", `⚠️ <b>${result.failed.length} not created:</b>`);
        for (const failure of result.failed) {
            const name = nameByStaffId.get(failure.staffId) || failure.staffId;
            lines.push(`• ${escapeHtml(name)}: ${formatResultError(failure.error)}`);
        }
    }

    if (notifyFailures.length > 0) {
        lines.push("", `📵 <b>${notifyFailures.length} not notified</b> (bot may be blocked):`);
        for (const name of notifyFailures) {
            lines.push(`• ${escapeHtml(name)}`);
        }
    }

    return lines.join("\n");
}

taskBulkHandlers.callbackQuery("tbk_send", async (ctx: MyContext) => {
    const data = ctx.session.bulkTaskData;
    if (!data) return;

    // Session state is only cleared at the very end of this handler, after a loop that
    // awaits one Telegram send per recipient (potentially 30+ sequential network calls).
    // Marking the flow spent up front — before that loop — closes the re-entry window a
    // double tap could otherwise land in, so a second tap finds nothing left to send.
    if (data.step === "SENDING") return;
    data.step = "SENDING";

    const groups = await loadRecipientGroups(ctx);
    const excluded = new Set(data.excludedStaffIds || []);
    const recipients = groups.flatMap(g => g.staff.filter(s => !excluded.has(s.id)));

    if (recipients.length === 0) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["admin-bulk-err-no-recipients"], show_alert: true }).catch(() => { });
        data.step = "CONFIRM";
        return;
    }

    await ctx.answerCallbackQuery().catch(() => { });

    const telegramIdByStaffId = new Map<string, bigint | null>(
        recipients.map(s => [s.id, s.user?.telegramId ?? null]),
    );
    const nameByStaffId = new Map<string, string>(
        recipients.map(s => [s.id, formatStaffName(s.fullName || "Staff")]),
    );

    const result = await taskService.createTasksBulk({
        staffIds: recipients.map(s => s.id),
        taskText: data.taskText!,
        workDate: new Date(`${data.date}T00:00:00`),
        deadlineTime: data.deadlineTime ?? null,
        fileId: data.fileId ?? null,
        createdById: ctx.from!.id.toString(),
        completionMode: data.completionMode ?? TaskCompletionMode.QUICK,
        telegramIdByStaffId,
    });

    const notifyFailures: string[] = [];
    const dateLabel = new Date(`${data.date}T00:00:00`).toLocaleDateString("uk-UA");
    const taskMessage = buildTaskNotificationText({
        text: data.taskText || "",
        date: dateLabel,
        deadlineTime: data.deadlineTime,
        completionMode: data.completionMode,
    });
    const staffKb = new InlineKeyboard().text(taskNotificationButtonLabel(), TASK_NOTIFICATION_BUTTON_CALLBACK);

    for (const created of result.created) {
        const name = nameByStaffId.get(created.staffId) || created.staffId;
        if (!created.telegramId) {
            notifyFailures.push(name);
            continue;
        }
        try {
            const options: {
                replyMarkup: InlineKeyboard;
                textIsHtml: boolean;
                fileId?: string | null;
                mediaType?: "photo" | "video" | "document" | "voice" | "video_note" | "audio" | "animation";
            } = { replyMarkup: staffKb, textIsHtml: true };
            if (data.fileId) options.fileId = data.fileId;
            if (data.mediaType) options.mediaType = data.mediaType;
            await sendTaskNotification(ctx, Number(created.telegramId), taskMessage, options);
        } catch {
            notifyFailures.push(name);
        }
    }

    const report = buildResultReport(result, notifyFailures, nameByStaffId);

    delete ctx.session.bulkTaskData;
    if (ctx.session.adminFlow === 'BULK_TASK') delete ctx.session.adminFlow;

    const keyboard = new InlineKeyboard().text(ADMIN_TEXTS["admin-sys-back"], `task_dash_${data.date}_0`);
    await ScreenManager.renderScreen(ctx, report, keyboard);
});
