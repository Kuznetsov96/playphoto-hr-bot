import { Composer, InlineKeyboard } from "grammy";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import type { MyContext } from "../../types/context.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { userRepository } from "../../repositories/user-repository.js";
import { taskService } from "../../services/task-service.js";
import { build14DayCalendar, formatStaffName } from "../../utils/task-helpers.js";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";

export const taskFlowHandlers = new Composer<MyContext>();

export async function startTaskFlow(ctx: MyContext, identifier?: string) {
    ctx.session.adminFlow = 'TASK';
    delete ctx.session.broadcastData;
    delete ctx.session.taskCreation;
    ctx.session.taskData = { step: 'SELECT_STAFF' } as any;
    if (identifier) {
        // First try finding by StaffProfile.userId, then fallback to StaffProfile.id
        let staff = await staffRepository.findByUserId(identifier);
        if (!staff) {
            staff = await staffRepository.findById(identifier);
        }

        if (staff) {
            ctx.session.taskData!.staffId = staff.id;
            ctx.session.taskData!.staffName = formatStaffName(staff.fullName);
            ctx.session.taskData!.city = staff.location?.city || "Unknown";
            ctx.session.taskData!.locationName = staff.location?.name || "Unknown";
            ctx.session.taskData!.step = 'SELECT_DATE';
            return await renderDateSelection(ctx);
        }
    }
    await ctx.reply("❌ Please select a staff member.");
}

async function renderDateSelection(ctx: MyContext) {
    if (!ctx.session.taskData) return;
    const kb = new InlineKeyboard();
    build14DayCalendar("task_date_").forEach(row => kb.row(...row));
    kb.text("❌ Cancel", "task_cancel_flow");
    const text = `📅 <b>Task for ${ctx.session.taskData.staffName}</b>\n\nSelect date:`;
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

taskFlowHandlers.callbackQuery(/^task_date_(.+)$/, async (ctx) => {
    if (!ctx.session.taskData) return ctx.answerCallbackQuery("Session expired.");
    ctx.session.taskData.workDate = ctx.match![1]!;
    ctx.session.taskData.step = 'AWAITING_TEXT';
    await renderTextPrompt(ctx);
    await ctx.answerCallbackQuery();
});

async function renderTextPrompt(ctx: MyContext) {
    const data = ctx.session.taskData;
    if (!data) return;
    const text = `📝 <b>Task Text</b>\n👤 Staff: ${data.staffName}\n\n👇 <b>Write task text now:</b>`;
    const kb = new InlineKeyboard().text("⬅️ Back", "task_back_date").text("❌ Cancel", "task_cancel_flow");
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

export async function handleTaskText(ctx: MyContext) {
    if (!ctx.session.taskData) return false;
    if (ctx.session.adminFlow !== 'TASK') return false;
    const step = ctx.session.taskData.step;
    if (step !== 'AWAITING_TEXT' && step !== 'SET_DEADLINE') return false;
    if (ctx.chat?.type !== "private") return false;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    if (!hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT')) return false;

    const text = ctx.message?.text;
    if (!text) return false;

    await ctx.deleteMessage().catch(() => {});

    if (step === 'AWAITING_TEXT') {
        ctx.session.taskData.text = text;
        ctx.session.taskData.step = 'SET_DEADLINE';
        await renderDeadlineSelection(ctx);
        return true;
    } 
    
    if (step === 'SET_DEADLINE') {
        const timeInput = text.trim();
        if (/^\d{1,2}:\d{2}$/.test(timeInput)) {
            ctx.session.taskData.deadlineTime = timeInput;
            ctx.session.taskData.step = 'CONFIRMATION';
            await renderConfirmation(ctx);
            return true;
        } else {
            await ScreenManager.renderScreen(ctx, "❌ Невірний формат часу. Введіть HH:MM (наприклад, 15:00) або скористайтеся кнопками:");
            return true;
        }
    }

    return false;
}

async function renderDeadlineSelection(ctx: MyContext) {
    const data = ctx.session.taskData;
    if (!data) return;

    const dateStr = data.workDate!;
    const prettyDate = dateStr.split("-").reverse().slice(0, 2).join(".");

    const kb = new InlineKeyboard();
    kb.text("🌑 End of day", "task_time_23:59")
    kb.text("⏩ No time", "task_time_none").row();
    kb.text("⬅️ Back to Text", "task_back_text").text("❌ Cancel", "task_cancel_flow");

    const text = `⏰ <b>Set Deadline</b>\n👤 Staff: ${data.staffName}\n📅 Date: ${prettyDate}\n📝 Text: <i>${data.text}</i>\n\n👇 <b>Select or write time (e.g. 15:00):</b>`;
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

taskFlowHandlers.callbackQuery(/^task_time_(.+)$/, async (ctx) => {
    if (!ctx.session.taskData) return ctx.answerCallbackQuery("Session expired.");
    const time = ctx.match![1]!;
    ctx.session.taskData.deadlineTime = time === "none" ? null : time;
    ctx.session.taskData.step = 'CONFIRMATION';
    await renderConfirmation(ctx);
    await ctx.answerCallbackQuery();
});

taskFlowHandlers.callbackQuery("task_back_text", async (ctx) => {
    if (!ctx.session.taskData) return ctx.answerCallbackQuery("Session expired.");
    ctx.session.taskData.step = 'AWAITING_TEXT';
    await renderTextPrompt(ctx);
    await ctx.answerCallbackQuery();
});

taskFlowHandlers.callbackQuery("task_back_date", async (ctx) => {
    if (!ctx.session.taskData) return ctx.answerCallbackQuery("Session expired.");
    ctx.session.taskData.step = 'SELECT_DATE';
    await renderDateSelection(ctx);
    await ctx.answerCallbackQuery();
});

async function renderConfirmation(ctx: MyContext) {
    const data = ctx.session.taskData;
    if (!data) return;
    
    const deadlineStr = data.deadlineTime ? ` ⏰ ${data.deadlineTime}` : " (No time)";
    
    const summary = `✅ <b>Task Confirmation</b>\n\n👤 <b>${data.staffName}</b>\n📅 ${new Date(data.workDate!).toLocaleDateString("uk-UA")}${deadlineStr}\n\n📝 <i>${data.text}</i>`;
    const kb = new InlineKeyboard().text("✅ Create", "task_confirm_save").row().text("⬅️ Back", "task_back_deadline").text("❌ Cancel", "task_cancel_flow");
    await ScreenManager.renderScreen(ctx, summary, kb, { pushToStack: true });
}

taskFlowHandlers.callbackQuery("task_back_deadline", async (ctx) => {
    if (!ctx.session.taskData) return ctx.answerCallbackQuery("Session expired.");
    ctx.session.taskData.step = 'SET_DEADLINE';
    await renderDeadlineSelection(ctx);
    await ctx.answerCallbackQuery();
});

taskFlowHandlers.callbackQuery("task_cancel_flow", async (ctx) => {
    const staffId = ctx.session.taskData?.staffId;
    delete ctx.session.taskData;
    await ctx.answerCallbackQuery("Cancelled.");
    
    const kb = new InlineKeyboard();
    if (staffId) {
        kb.text("👤 Back to Profile", `view_staff_${staffId}`).row();
    }
    kb.text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities").row()
      .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");

    await ScreenManager.renderScreen(ctx, "❌ Task creation cancelled.", kb);
});

taskFlowHandlers.callbackQuery("task_confirm_save", async (ctx) => {
    if (!ctx.session.taskData) return;
    const data = ctx.session.taskData;
    const staffId = data.staffId;

    try {
        const task = await taskService.createTask({
            staffId: data.staffId!,
            taskText: data.text!,
            workDate: new Date(data.workDate!),
            deadlineTime: data.deadlineTime || null,
            createdById: ctx.from!.id.toString()
        });

        delete ctx.session.taskData;
        
        // Notify photographer and check delivery
        let deliveryStatus = "✅ Task created and notification sent!";
        try {
            const staffUser = await userRepository.findByStaffProfileId(data.staffId!);
            if (staffUser?.telegramId) {
                const dateStr = task.workDate
                    ? new Date(task.workDate).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" })
                    : "";
                const deadlineStr = task.deadlineTime ? ` (до ${task.deadlineTime})` : "";
                const notifText =
                    `📋 <b>Нове завдання${dateStr ? ` на ${dateStr}` : ""}!</b>\n\n` +
                    `${task.taskText}${deadlineStr}`;
                
                await ctx.api.sendMessage(Number(staffUser.telegramId), notifText, {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("📋 Переглянути завдання", "staff_hub_tasks_redirect")
                });
            } else {
                deliveryStatus = "✅ Task created, but user has no Telegram ID linked.";
            }
        } catch (notifErr: any) {
            logger.warn({ err: notifErr }, "⚠️ Failed to send task notification to photographer");
            deliveryStatus = "⚠️ Task created, but <b>could not deliver notification</b> (user might have blocked the bot).";
        }

        const kb = new InlineKeyboard();
        if (staffId) kb.text("👤 Back to Profile", `view_staff_${staffId}`).row();
        kb.text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities").row()
          .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");

        await ScreenManager.renderScreen(ctx, deliveryStatus, kb);
    } catch (e: any) {
        const errKb = new InlineKeyboard()
            .text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities")
            .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
        await ScreenManager.renderScreen(ctx, `❌ Error: ${e.message}`, errKb);
    }
});
