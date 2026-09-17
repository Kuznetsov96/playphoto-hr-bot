import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { taskService } from "../../services/task-service.js";
import { taskProofService } from "../../services/task-proof-service.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { ScreenManager } from "../../utils/screen-manager.js";

import {
    buildProgressBar,
    build14DayCalendar,
    formatName,
    formatStaffName,
    truncateText,
    groupTasksByLocation,
    formatDeadline,
} from "../../utils/task-helpers.js";
import { kyivDateStr, isTaskUrgent } from "../../utils/format-deadline.js";
import { TELEGRAM_MESSAGE_LIMIT } from "../../constants/telegram-limits.js";
import { escapeHtml, htmlToPlainText, normalizeCity } from "./utils.js";


const composer = new Composer<MyContext>();

/**
 * Побудувати дашборд завдань
 */
export async function buildTasksDashboard(dateStr: string, page = 0, hideCompleted = false) {
    const date = new Date(dateStr);
    // Always fetched unfiltered: the header counters ("N/M completed") must
    // reflect the WHOLE day regardless of the toggle, or hiding completed
    // tasks would also hide the fact that they were ever done — "0/15" reads
    // as "nothing happened today", not "5 done, 15 remaining, 5 hidden".
    const allTasks = await taskService.getTasksForDate(date, false);
    const tasks = hideCompleted ? allTasks.filter((t: any) => !t.isCompleted) : allTasks;

    const day = date.getDate().toString().padStart(2, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const datePretty = `${day}.${month}`;

    // Header counters summarize the WHOLE day, never just the current page —
    // and never just the visible (post-toggle) subset either.
    const total = allTasks.length;
    const completed = allTasks.filter((t: any) => t.isCompleted).length;
    const urgent = allTasks.filter((t: any) => isTaskUrgent(t)).length;

    const PAGE_SIZE = 8;
    const startIdx = page * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    // The text body is built from the SAME slice as the keyboard below, so the
    // "№N" buttons and the rows described in the text always refer to the same
    // tasks. Telegram caps a message at 4096 chars; rendering every task of the
    // day into the text (while only paginating the keyboard) blew past that
    // limit on any day with ~35+ tasks and silently failed to send.
    //
    // Pagination is over `tasks` (post-toggle), not `allTasks`: page count and
    // page contents must match what hideCompleted actually shows.
    const pageTasks = tasks.slice(startIdx, endIdx);
    const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));

    let text = (ADMIN_TEXTS["admin-tasks-title"] || STAFF_TEXTS["admin-tasks-title"] || (() => "admin-tasks-title"))({ date: datePretty } as any) + "\n";
    text = text.replace(/[\u200B-\u200D\uFEFF\u2060-\u206F\u202A-\u202E]/g, "");

    // Apple-style Summary
    if (total > 0) {
        text += `📊 <b>${completed}/${total}</b> completed`;
        if (urgent > 0) text += `  |  🚨 <b>${urgent}</b> urgent`;
        if (totalPages > 1) {
            text += "\n" + ADMIN_TEXTS["admin-tasks-page-indicator"]({ page: page + 1, totalPages });
        }
        text += "\n\n";
    }

    if (tasks.length === 0) {
        // Distinguish "nothing exists for this day" from "everything is done
        // and hidden" — the toggle hiding every remaining row should not read
        // like the day never had any tasks.
        text += total > 0
            ? ADMIN_TEXTS["admin-tasks-all-hidden"]
            : (ADMIN_TEXTS["admin-tasks-no-tasks"] || STAFF_TEXTS["admin-tasks-no-tasks"] || "admin-tasks-no-tasks");
    }

    if (pageTasks.length > 0) {
        const urgentTasks = pageTasks.filter((t: any) => isTaskUrgent(t));
        const regularTasks = pageTasks.filter((t: any) => !isTaskUrgent(t));

        if (urgentTasks.length > 0) {
            text += (ADMIN_TEXTS["admin-tasks-urgent"] || STAFF_TEXTS["admin-tasks-urgent"] || "admin-tasks-urgent");
            for (const task of urgentTasks) {
                const staffName = formatStaffName(task.staff.fullName);
                const resolvedCity = task.city || task.staff?.location?.city || "";
                const resolvedLocationName = task.locationName || task.staff?.location?.name || (ADMIN_TEXTS["admin-tasks-loc-unknown"] || STAFF_TEXTS["admin-tasks-loc-unknown"] || "admin-tasks-loc-unknown");
                const englishCity = resolvedCity ? normalizeCity(resolvedCity) : "";
                const cityPrefix = englishCity ? `${englishCity}, ` : "";
                const timeStr = task.deadlineTime ? ` • ${task.deadlineTime.replace(":", ".")}` : "";
                const locationShort = truncateText(cityPrefix + resolvedLocationName, 25);
                text += `  ⏳ <b>${staffName}</b>\n     └ ${locationShort}${timeStr}\n`;
            }
        }

        const grouped = groupTasksByLocation(regularTasks);

        for (const [city, locations] of Object.entries(grouped)) {
            text += `\n🏙️ <b>${normalizeCity(city).toUpperCase()}</b>\n`;
            for (const [location, locationTasks] of Object.entries(locations)) {
                const cleanLocation = location.replace(/\s*\([^)]*\)\s*$/, "");
                const locationShort = truncateText(cleanLocation, 30);
                text += `  📍 <i>${locationShort}</i>\n`;
                for (const task of locationTasks) {
                    const statusEmoji = task.isCompleted ? "✅" : "⏳";
                    const staffName = formatStaffName(task.staff.fullName);
                    const timeStr = task.deadlineTime ? ` • ${task.deadlineTime.replace(":", ".")}` : "";
                    text += `    ${statusEmoji} ${staffName}${timeStr}\n`;
                }
            }
        }
    }

    // Defensive guard: even one page of tasks could in theory exceed the
    // limit (extreme name/location lengths). Truncate gracefully instead of
    // letting the send fail outright.
    if (text.length > TELEGRAM_MESSAGE_LIMIT) {
        const notice = ADMIN_TEXTS["admin-tasks-truncated-notice"];
        text = text.slice(0, TELEGRAM_MESSAGE_LIMIT - notice.length) + notice;
    }

    const keyboard = new InlineKeyboard();

    // `_0`/`_1` suffix carries the toggle through every navigation callback on
    // this screen (pagination, opening a task and coming back) so the chosen
    // mode survives instead of resetting on the next tap.
    const hideFlag = hideCompleted ? 1 : 0;

    for (let i = 0; i < pageTasks.length; i++) {
        const task = pageTasks[i];
        if (!task) continue;
        const globalIdx = startIdx + i + 1;
        const nameParts = (task.staff.fullName || "").trim().split(/\s+/);
        const lastName = nameParts[0] || "Unknown";
        keyboard.text(`№${globalIdx} | ${lastName}`, `task_det_${task.id}_${dateStr}_${page}_${hideFlag}`).row();
    }

    const navRow = [];
    const nextBtnLabel = (ADMIN_TEXTS["admin-tasks-next"] || STAFF_TEXTS["admin-tasks-next"] || "admin-tasks-next");

    if (page > 0) {
        navRow.push({ text: (ADMIN_TEXTS["admin-sys-back"] || STAFF_TEXTS["admin-sys-back"] || "admin-sys-back"), callback_data: `task_page_${page - 1}_${dateStr}_${hideFlag}` });
    }
    if (endIdx < tasks.length) {
        navRow.push({ text: nextBtnLabel, callback_data: `task_page_${page + 1}_${dateStr}_${hideFlag}` });
    }
    if (navRow.length > 0) {
        keyboard.row(...navRow);
    }

    // Distinct prefix (not `task_dash_...`) on purpose: `/^task_dash_/` is
    // registered as a callback matcher below, and a `task_dash_toggle_...`
    // callback_data would also match that broader prefix — handler order
    // would then decide which one wins instead of the data being unambiguous
    // on its own.
    const toggleLabel = hideCompleted
        ? ADMIN_TEXTS["admin-tasks-toggle-hide-on"]
        : ADMIN_TEXTS["admin-tasks-toggle-hide-off"];
    keyboard.text(toggleLabel, `task_hide_${dateStr}_${page}_${hideCompleted ? 0 : 1}`).row();

    keyboard.text((ADMIN_TEXTS["admin-tasks-history"] || STAFF_TEXTS["admin-tasks-history"] || "admin-tasks-history"), "task_calendar_open").row();
    keyboard.text((ADMIN_TEXTS["admin-tasks-new"] || STAFF_TEXTS["admin-tasks-new"] || "admin-tasks-new"), `task_add_start_${dateStr}`).row();
    keyboard.text(ADMIN_TEXTS["admin-bulk-entry"], "tbk_start").row();
    keyboard.text((ADMIN_TEXTS["admin-sys-back"] || STAFF_TEXTS["admin-sys-back"] || "admin-sys-back"), "admin_system_back");

    return { text, keyboard };
}

/**
 * Показати деталі завдання
 */
async function showTaskDetails(ctx: MyContext, taskId: string, dateStr: string, page = 0, hideCompleted = false) {
    const task = await taskService.getTaskById(taskId);

    if (!task) {
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-not-found"]).catch(() => { });
        return;
    }

    const staffName = formatStaffName(task.staff.fullName);
    const status = task.isCompleted ? ADMIN_TEXTS["admin-tasks-status-done"] : ADMIN_TEXTS["admin-tasks-status-pending"];
    const completionModeLabel = task.completionMode === "PROOF_REQUIRED" ? "Proof Required" : "Quick Completion";
    const proofSubmission = task.proofSubmission;

    let dateDisplay = ADMIN_TEXTS["admin-tasks-date-soon"];
    if (task.workDate) {
        const wd = new Date(task.workDate);
        const day = wd.getDate().toString().padStart(2, "0");
        const month = (wd.getMonth() + 1).toString().padStart(2, "0");
        const year = wd.getFullYear();
        dateDisplay = `${day}.${month}.${year}`;
    }

    const deadline = task.deadlineTime ? ` (do ${task.deadlineTime})` : "";

    let text = ADMIN_TEXTS["admin-tasks-details-title"] + "\n\n";
    text = text.replace(/[\u200B-\u200D\uFEFF\u2060-\u206F\u202A-\u202E]/g, "");

    const resolvedCity = task.city || task.staff?.location?.city || ADMIN_TEXTS["admin-tasks-loc-unknown"];
    const resolvedLocationName = task.locationName || task.staff?.location?.name || ADMIN_TEXTS["admin-tasks-loc-unknown"];

    text += ADMIN_TEXTS["admin-tasks-whom"]({ name: staffName }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-date"]({ date: dateDisplay, deadline }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-city"]({ city: resolvedCity }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-location"]({ location: resolvedLocationName }) + "\n";
    text += `⚙️ <b>Completion Type:</b> ${completionModeLabel}\n`;
    text += ADMIN_TEXTS["admin-tasks-text"]({ text: task.taskText }) + "\n\n";

    if (task.fileId) {
        text += ADMIN_TEXTS["admin-tasks-has-file"] + "\n";
    }

    text += ADMIN_TEXTS["admin-tasks-status-label"]({ status }) + "\n";
    if (task.completedAt) {
        text += `🕒 <b>Completed at:</b> ${new Date(task.completedAt).toLocaleString("uk-UA")}\n`;
    }
    if (task.completionMode === "PROOF_REQUIRED") {
        const proofStatus = proofSubmission?.status === "SUBMITTED"
            ? `Submitted (${proofSubmission.items.length})`
            : proofSubmission?.status === "DRAFT"
                ? `Draft (${proofSubmission.items.length})`
                : "Not submitted";
        text += `📎 <b>Proof:</b> ${proofStatus}\n`;
    }

    const hideFlag = hideCompleted ? 1 : 0;
    const keyboard = new InlineKeyboard();
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-toggle"], `task_toggle_${taskId}_${dateStr}_${page}_${hideFlag}`).row();

    if (task.fileId) {
        keyboard.text(ADMIN_TEXTS["admin-tasks-btn-view-file"], `task_view_file_${taskId}`).row();
    }
    if (proofSubmission?.items.length) {
        keyboard.text("📎 View Proof", `task_view_proof_${taskId}`).row();
    }

    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-msg-staff"], `admin_msg_staff_${task.staffId}`).row();
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-delete"], `task_del_conf_${taskId}_${dateStr}_${page}_${hideFlag}`).danger().row();
    // Back to the SAME page and hide-mode the admin came from, not a reset to
    // page 0 / hideCompleted=false — otherwise opening a task and coming back
    // would silently drop both.
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-back-list"], `task_page_${page}_${dateStr}_${hideFlag}`);

    await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
}

/** "1"/"0" (or anything else) → boolean, defaulting safely to false. */
function parseHideFlag(raw: string | undefined): boolean {
    return raw === "1";
}

// Обробник головного дашборду
composer.callbackQuery(/^task_dash_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_dash_", "").split("_");
    const dateStr = data[0] || kyivDateStr(new Date()) || "";

    const { text, keyboard } = await buildTasksDashboard(dateStr, 0);
    await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник перемикача "Hide completed" — окремий префікс, щоб не перетинатись
// з /^task_dash_/ вище (див. коментар у buildTasksDashboard).
composer.callbackQuery(/^task_hide_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_hide_", "").split("_");
    const dateStr = data[0] || kyivDateStr(new Date()) || "";
    const page = parseInt(data[1] || "0");
    const hideCompleted = parseHideFlag(data[2]);

    const { text, keyboard } = await buildTasksDashboard(dateStr, page, hideCompleted);
    await ScreenManager.renderScreen(ctx, text, keyboard);
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник пагінації
composer.callbackQuery(/^task_page_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_page_", "").split("_");
    const page = parseInt(data[0] || "0");
    const dateStr = data[1] || kyivDateStr(new Date()) || "";
    const hideCompleted = parseHideFlag(data[2]);

    const { text, keyboard } = await buildTasksDashboard(dateStr, page, hideCompleted);
    await ScreenManager.renderScreen(ctx, text, keyboard);
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник деталей завдання
composer.callbackQuery(/^task_det_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_det_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || kyivDateStr(new Date()) || "";
    const page = parseInt(data[2] || "0");
    const hideCompleted = parseHideFlag(data[3]);

    await showTaskDetails(ctx, taskId, dateStr, page, hideCompleted);
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник зміни статусу
composer.callbackQuery(/^task_toggle_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_toggle_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || kyivDateStr(new Date()) || "";
    const page = parseInt(data[2] || "0");
    const hideCompleted = parseHideFlag(data[3]);

    await taskService.toggleTaskStatus(taskId);
    await showTaskDetails(ctx, taskId, dateStr, page, hideCompleted);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-toggled"]).catch(() => { });
});

// Обробник підтвердження видалення
composer.callbackQuery(/^task_del_conf_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_del_conf_", "").split("_");
    const taskId = data[0]!;
    const dateStr = data[1]!;
    const page = parseInt(data[2] || "0");
    const hideFlag = data[3] || "0";

    const keyboard = new InlineKeyboard();
    keyboard.text(ADMIN_TEXTS["admin-tasks-del-yes"], `task_del_exec_${taskId}_${dateStr}_${page}_${hideFlag}`).danger().row();
    keyboard.text(ADMIN_TEXTS["admin-tasks-del-no"], `task_det_${taskId}_${dateStr}_${page}_${hideFlag}`).danger();

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-tasks-del-conf"], keyboard);
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник видалення
composer.callbackQuery(/^task_del_exec_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_del_exec_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || kyivDateStr(new Date()) || "";
    const page = parseInt(data[2] || "0");
    const hideCompleted = parseHideFlag(data[3]);

    await taskService.deleteTask(taskId);
    const { text, keyboard } = await buildTasksDashboard(dateStr, page, hideCompleted);
    await ScreenManager.renderScreen(ctx, text, keyboard);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-deleted"]).catch(() => { });
});

// Обробник календаря
composer.callbackQuery("task_calendar_open", async (ctx: MyContext) => {
    const keyboard = new InlineKeyboard();
    const calendarButtons = build14DayCalendar("task_dash_");

    for (const row of calendarButtons) {
        keyboard.row(...row);
    }

    keyboard.text(ADMIN_TEXTS["admin-sys-back"], `task_dash_${kyivDateStr(new Date())}_0`);
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-tasks-calendar-title"], keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery().catch(() => { });
});

// Обробник перегляду файлу завдання
composer.callbackQuery(/^task_view_file_(.+)$/, async (ctx: MyContext) => {
    const taskId = ctx.match![1]!;
    await ctx.answerCallbackQuery().catch(() => { });
    const task = await taskService.getTaskById(taskId);
    if (!task?.fileId) {
        await ctx.reply("⚠️ File not found for this task.");
        return;
    }
    await ctx.replyWithDocument(task.fileId).catch(async () => {
        await ctx.reply("⚠️ Could not retrieve the file. It may have been deleted.");
    });
});

composer.callbackQuery(/^task_view_proof_(.+)$/, async (ctx: MyContext) => {
    const taskId = ctx.match![1]!;
    await ctx.answerCallbackQuery().catch(() => { });

    const submission = await taskProofService.getSubmission(taskId);
    if (!submission || submission.items.length === 0) {
        await ctx.reply("⚠️ Proof has not been submitted yet.");
        return;
    }

    const header =
        `📎 <b>Task Proof</b>\n` +
        `👤 ${escapeHtml(submission.staff.fullName)}\n` +
        `🆔 <code>${submission.task.id}</code>\n` +
        `📦 Items: <b>${submission.items.length}</b>\n\n` +
        `<i>${escapeHtml(htmlToPlainText(submission.task.taskText))}</i>`;
    await ctx.reply(header, { parse_mode: "HTML" });

    for (const item of submission.items) {
        const caption = item.caption || undefined;
        if (item.type === "TEXT" && item.text) {
            await ctx.reply(`📝 ${item.text}`);
            continue;
        }

        if (!item.telegramFileId) continue;

        if (item.type === "PHOTO") {
            await ctx.replyWithPhoto(item.telegramFileId, caption ? { caption } : undefined);
        } else if (item.type === "VIDEO") {
            await ctx.replyWithVideo(item.telegramFileId, caption ? { caption } : undefined);
        } else if (item.type === "DOCUMENT") {
            await ctx.replyWithDocument(item.telegramFileId, caption ? { caption } : undefined);
        } else if (item.type === "VOICE") {
            await ctx.replyWithVoice(item.telegramFileId);
        } else if (item.type === "AUDIO") {
            await ctx.replyWithAudio(item.telegramFileId, caption ? { caption } : undefined);
        } else if (item.type === "ANIMATION") {
            await ctx.replyWithAnimation(item.telegramFileId, caption ? { caption } : undefined);
        }
    }
});

// Обробник написання повідомлення співробітнику з деталей завдання
composer.callbackQuery(/^admin_msg_staff_(.+)$/, async (ctx: MyContext) => {
    const staffId = ctx.match![1]!;
    await ctx.answerCallbackQuery().catch(() => { });
    const staff = await staffRepository.findById(staffId);
    if (!staff) {
        await ctx.reply("❌ Staff not found.");
        return;
    }
    const { startAdminMessageFlow } = await import("./search.js");
    await startAdminMessageFlow(ctx, staff.userId);
});

// Вхід у майстер масової постановки задач (динамічний імпорт запобігає
// циклу tasks.ts <-> task-bulk.ts)
composer.callbackQuery("tbk_start", async (ctx: MyContext) => {
    const { startBulkTask } = await import("./task-bulk.js");
    await startBulkTask(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

export default composer;
