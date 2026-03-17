import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { taskService } from "../../services/task-service.js";
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
import { normalizeCity } from "./utils.js";


const composer = new Composer<MyContext>();

/**
 * Побудувати дашборд завдань
 */
export async function buildTasksDashboard(dateStr: string, page = 0) {
    const date = new Date(dateStr);
    const tasks = await taskService.getTasksForDate(date, false);

    const day = date.getDate().toString().padStart(2, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const datePretty = `${day}.${month}`;

    const total = tasks.length;
    const completed = tasks.filter((t: any) => t.isCompleted).length;
    const urgent = tasks.filter((t: any) => !t.isCompleted && t.deadlineTime).length;

    let text = (ADMIN_TEXTS["admin-tasks-title"] || STAFF_TEXTS["admin-tasks-title"] || (() => "admin-tasks-title"))({ date: datePretty } as any) + "\n";
    text = text.replace(/[\u200B-\u200D\uFEFF\u2060-\u206F\u202A-\u202E]/g, "");

    // Apple-style Summary
    if (total > 0) {
        text += `📊 <b>${completed}/${total}</b> completed`;
        if (urgent > 0) text += `  |  🚨 <b>${urgent}</b> urgent`;
        text += "\n\n";
    }

    if (tasks.length === 0) {
        text += (ADMIN_TEXTS["admin-tasks-no-tasks"] || STAFF_TEXTS["admin-tasks-no-tasks"] || "admin-tasks-no-tasks");
    }

    if (tasks.length > 0) {
        const urgentTasks = tasks.filter((t: any) => !t.isCompleted && t.deadlineTime);
        const regularTasks = tasks.filter((t: any) => t.isCompleted || !t.deadlineTime);

        if (urgentTasks.length > 0) {
            text += (ADMIN_TEXTS["admin-tasks-urgent"] || STAFF_TEXTS["admin-tasks-urgent"] || "admin-tasks-urgent");
            for (const task of urgentTasks) {
                const staffName = formatStaffName(task.staff.fullName);
                const englishCity = task.city ? normalizeCity(task.city) : "";
                const cityPrefix = englishCity ? `${englishCity}, ` : "";
                const timeStr = task.deadlineTime ? ` • ${task.deadlineTime.replace(":", ".")}` : "";
                const locationShort = truncateText(cityPrefix + (task.locationName || (ADMIN_TEXTS["admin-tasks-loc-unknown"] || STAFF_TEXTS["admin-tasks-loc-unknown"] || "admin-tasks-loc-unknown")), 25);
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

    const PAGE_SIZE = 8;
    const startIdx = page * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    const pageTasks = tasks.slice(startIdx, endIdx);

    const keyboard = new InlineKeyboard();

    for (let i = 0; i < pageTasks.length; i++) {
        const task = pageTasks[i];
        if (!task) continue;
        const globalIdx = startIdx + i + 1;
        const nameParts = (task.staff.fullName || "").trim().split(/\s+/);
        const lastName = nameParts[0] || "Unknown";
        keyboard.text(`№${globalIdx} | ${lastName}`, `task_det_${task.id}_${dateStr}`).row();
    }

    const navRow = [];
    const nextBtnLabel = (ADMIN_TEXTS["admin-tasks-next"] || STAFF_TEXTS["admin-tasks-next"] || "admin-tasks-next");

    if (page > 0) {
        navRow.push({ text: (ADMIN_TEXTS["admin-sys-back"] || STAFF_TEXTS["admin-sys-back"] || "admin-sys-back"), callback_data: `task_page_${page - 1}_${dateStr}` });
    }
    if (endIdx < tasks.length) {
        navRow.push({ text: nextBtnLabel, callback_data: `task_page_${page + 1}_${dateStr}` });
    }
    if (navRow.length > 0) {
        keyboard.row(...navRow);
    }

    keyboard.text((ADMIN_TEXTS["admin-tasks-history"] || STAFF_TEXTS["admin-tasks-history"] || "admin-tasks-history"), "task_calendar_open").row();
    keyboard.text((ADMIN_TEXTS["admin-tasks-new"] || STAFF_TEXTS["admin-tasks-new"] || "admin-tasks-new"), `task_add_start_${dateStr}`).row();
    keyboard.text((ADMIN_TEXTS["admin-sys-back"] || STAFF_TEXTS["admin-sys-back"] || "admin-sys-back"), "admin_system_back");

    return { text, keyboard };
}

/**
 * Показати деталі завдання
 */
async function showTaskDetails(ctx: MyContext, taskId: string, dateStr: string) {
    const task = await taskService.getTaskById(taskId);

    if (!task) {
        await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-not-found"]);
        return;
    }

    const staffName = formatStaffName(task.staff.fullName);
    const status = task.isCompleted ? ADMIN_TEXTS["admin-tasks-status-done"] : ADMIN_TEXTS["admin-tasks-status-pending"];
    
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
    
    text += ADMIN_TEXTS["admin-tasks-whom"]({ name: staffName }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-date"]({ date: dateDisplay, deadline }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-city"]({ city: task.city || ADMIN_TEXTS["admin-tasks-loc-unknown"] }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-location"]({ location: task.locationName || ADMIN_TEXTS["admin-tasks-loc-unknown"] }) + "\n";
    text += ADMIN_TEXTS["admin-tasks-text"]({ text: task.taskText }) + "\n\n";

    if (task.fileId) {
        text += ADMIN_TEXTS["admin-tasks-has-file"] + "\n";
    }

    text += ADMIN_TEXTS["admin-tasks-status-label"]({ status }) + "\n";

    const keyboard = new InlineKeyboard();
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-toggle"], `task_toggle_${taskId}_${dateStr}`).row();

    if (task.fileId) {
        keyboard.text(ADMIN_TEXTS["admin-tasks-btn-view-file"], `task_view_file_${taskId}`).row();
    }

    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-msg-staff"], `admin_msg_staff_${task.staffId}`).row();
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-delete"], `task_del_conf_${taskId}_${dateStr}`).row();
    keyboard.text(ADMIN_TEXTS["admin-tasks-btn-back-list"], `task_dash_${dateStr}`);

    await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
}

// Обробник головного дашборду
composer.callbackQuery(/^task_dash_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_dash_", "").split("_");
    const dateStr = data[0] || new Date().toISOString().split("T")[0] || "";

    const { text, keyboard } = await buildTasksDashboard(dateStr, 0);
    await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

// Обробник пагінації
composer.callbackQuery(/^task_page_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_page_", "").split("_");
    const page = parseInt(data[0] || "0");
    const dateStr = data[1] || new Date().toISOString().split("T")[0] || "";

    const { text, keyboard } = await buildTasksDashboard(dateStr, page);
    await ScreenManager.renderScreen(ctx, text, keyboard);
    await ctx.answerCallbackQuery();
});

// Обробник деталей завдання
composer.callbackQuery(/^task_det_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_det_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || new Date().toISOString().split("T")[0] || "";

    await showTaskDetails(ctx, taskId, dateStr);
    await ctx.answerCallbackQuery();
});

// Обробник зміни статусу
composer.callbackQuery(/^task_toggle_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_toggle_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || new Date().toISOString().split("T")[0] || "";

    await taskService.toggleTaskStatus(taskId);
    await showTaskDetails(ctx, taskId, dateStr);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-toggled"]);
});

// Обробник підтвердження видалення
composer.callbackQuery(/^task_del_conf_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_del_conf_", "").split("_");
    const taskId = data[0]!;
    const dateStr = data[1]!;

    const keyboard = new InlineKeyboard();
    keyboard.text(ADMIN_TEXTS["admin-tasks-del-yes"], `task_del_exec_${taskId}_${dateStr}`).row();
    keyboard.text(ADMIN_TEXTS["admin-tasks-del-no"], `task_det_${taskId}_${dateStr}`);

    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-tasks-del-conf"], keyboard);
    await ctx.answerCallbackQuery();
});

// Обробник видалення
composer.callbackQuery(/^task_del_exec_/, async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!.replace("task_del_exec_", "").split("_");
    const taskId = data[0] || "";
    const dateStr = data[1] || new Date().toISOString().split("T")[0] || "";

    await taskService.deleteTask(taskId);
    const { text, keyboard } = await buildTasksDashboard(dateStr, 0);
    await ScreenManager.renderScreen(ctx, text, keyboard);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-tasks-ans-deleted"]);
});

// Обробник календаря
composer.callbackQuery("task_calendar_open", async (ctx: MyContext) => {
    const keyboard = new InlineKeyboard();
    const calendarButtons = build14DayCalendar("task_dash_");

    for (const row of calendarButtons) {
        keyboard.row(...row);
    }

    keyboard.text(ADMIN_TEXTS["admin-sys-back"], `task_dash_${new Date().toISOString().split("T")[0]}_0`);
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-tasks-calendar-title"], keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

export default composer;
