import { Composer, InlineKeyboard } from "grammy";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import type { MyContext } from "../../types/context.js";
import { taskService } from "../../services/task-service.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { build14DayCalendar, formatStaffName } from "../../utils/task-helpers.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import logger from "../../core/logger.js";

const composer = new Composer<MyContext>();

// Обробник початку створення завдання
composer.callbackQuery(/^task_add_start(_.*)?$/, async (ctx) => {
    ctx.session.adminFlow = 'TASK';
    delete ctx.session.broadcastData;
    const data = ctx.callbackQuery.data.replace("task_add_start", "");
    const preselectedDate = data.startsWith("_") ? data.substring(1) : null;

    if (preselectedDate) {
        const keyboard = new InlineKeyboard();
        keyboard.text(`✅ Yes, for ${preselectedDate}`, `tas_d_${preselectedDate}`).row();
        keyboard.text("📅 Choose another date", "task_add_by_date").row();
        keyboard.text("⬅️ Back", `task_dash_${preselectedDate}`);

        await ScreenManager.renderScreen(
            ctx,
            `➕ <b>New Task Creation</b>\n\nDate: <b>${preselectedDate}</b>\n\nDo you want to use this date or pick another?`,
            keyboard,
            { pushToStack: true }
        );
    } else {
        const keyboard = new InlineKeyboard();
        keyboard.text("📅 For specific date", "task_add_by_date").row();
        keyboard.text("⬅️ Back", "admin_system_back");

        await ScreenManager.renderScreen(ctx, "⚙️ <b>How do you want to set the task?</b>", keyboard, { pushToStack: true });
    }

    await ctx.answerCallbackQuery();
});

// Обробник вибору дати
composer.callbackQuery("task_add_by_date", async (ctx) => {
    const keyboard = new InlineKeyboard();
    build14DayCalendar("tas_d_").forEach(row => keyboard.row(...row));
    keyboard.text("⬅️ Back", "task_add_start");

    await ScreenManager.renderScreen(ctx, "📅 <b>Select execution date:</b>", keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

// Обробник вибору дати - перехід до вибору міста
composer.callbackQuery(/^tas_d_/, async (ctx) => {
    const dateStr = ctx.callbackQuery.data.replace("tas_d_", "");

    if (!ctx.session.taskCreation) {
        ctx.session.taskCreation = {};
    }
    ctx.session.taskCreation.date = dateStr;

    // IF we already have text, we probably want to go back to deadline setting
    if (ctx.session.taskCreation.taskText) {
        ctx.session.taskCreation.step = "setting_time";
        const prettyDate = dateStr.split("-").reverse().slice(0, 2).join(".");
        const keyboard = new InlineKeyboard();
        keyboard.text("🌑 End of day", "tas_time_23:59")
        keyboard.text("⏩ No time", "tas_time_none").row();
        keyboard.text("📝 Edit text", "tas_edit_text")
        keyboard.text("📅 Change date", "tas_change_date").row();
        keyboard.text("❌ Cancel", "task_creation_cancel");

        await ScreenManager.renderScreen(
            ctx,
            `📍 Task for ${ctx.session.taskCreation.staffName}:\n<i>${ctx.session.taskCreation.taskText || "[Media]"}</i>\n📅 <b>Date:</b> ${prettyDate}\n\n⏰ <b>Set deadline (e.g. 15:00):</b>`,
            keyboard,
            { pushToStack: true }
        );
        await ctx.answerCallbackQuery();
        return;
    }

    // Check if staff is already selected (Direct Task Assignment)
    if (ctx.session.taskCreation.selectedStaffIds && ctx.session.taskCreation.selectedStaffIds.length > 0) {
        ctx.session.taskCreation.step = "entering_text";
        const keyboard = new InlineKeyboard().text("⬅️ Back", `task_add_by_date`);

        await ScreenManager.renderScreen(
            ctx,
            `📝 <b>Enter task for ${ctx.session.taskCreation.staffName}:</b>\n\n<i>You can add <b>photo</b> or <b>file</b> to the task.</i>`,
            keyboard,
            { pushToStack: true }
        );
        await ctx.answerCallbackQuery();
        return;
    }

    ctx.session.taskCreation.step = "selecting_city";
    const cities = await locationRepository.findAllCities();
    const keyboard = new InlineKeyboard();
    cities.forEach(city => keyboard.text(city, `tas_city_${city}`).row());
    keyboard.text("⬅️ Back", "task_add_by_date");

    await ScreenManager.renderScreen(ctx, `📅 Date: ${dateStr}\n🏙️ <b>Select city:</b>`, keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

// Обробник вибору міста - перехід до вибору локації
composer.callbackQuery(/^tas_city_/, async (ctx) => {
    const city = ctx.callbackQuery.data.replace("tas_city_", "");
    if (!ctx.session.taskCreation) return ctx.answerCallbackQuery("Error: Session lost");

    ctx.session.taskCreation.city = city;
    ctx.session.taskCreation.step = "selecting_location";

    const locations = await locationRepository.findByCity(city);

    if (locations.length === 1) {
        const location = locations[0]!;
        ctx.session.taskCreation.locationId = location.id;
        ctx.session.taskCreation.locationName = `${location.name} (${city})`;
        ctx.session.taskCreation.step = "selecting_staff";

        const staff = await staffRepository.findByLocation(location.id);
        const staffKeyboard = new InlineKeyboard();
        const selectedIds = ctx.session.taskCreation.selectedStaffIds || [];

        for (const s of staff) {
            const name = formatStaffName(s.fullName);
            const isSelected = selectedIds.includes(s.id);
            const icon = isSelected ? "✅" : "☐";
            staffKeyboard.text(`${icon} ${name}`, `tas_st_tg_${s.id}`).row();
        }

        if (selectedIds.length > 0) staffKeyboard.text("➡️ Done", "tas_st_done").row();
        staffKeyboard.text("⬅️ Back", `tas_d_${ctx.session.taskCreation.date}`);

        await ScreenManager.renderScreen(
            ctx,
            `📅 Date: ${ctx.session.taskCreation.date}\n📍 Location: ${location.name} (${city})\n👤 <b>Select staff (multi-select):</b>`,
            staffKeyboard,
            { pushToStack: true }
        );
        await ctx.answerCallbackQuery();
        return;
    }

    const keyboard = new InlineKeyboard();
    for (const loc of locations) keyboard.text(`${loc.name} (${city})`, `tas_loc_${loc.id}`).row();
    keyboard.text("⬅️ Back", `tas_d_${ctx.session.taskCreation.date}`);

    await ScreenManager.renderScreen(ctx, `📅 Date: ${ctx.session.taskCreation.date}\n📍 <b>Select location:</b>`, keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

// Обробник вибору локації - перехід до вибору співробітника
composer.callbackQuery(/^tas_loc_/, async (ctx) => {
    const locationId = ctx.callbackQuery.data.replace("tas_loc_", "");
    if (!ctx.session.taskCreation) return ctx.answerCallbackQuery("Error: Session lost");

    const location = await locationRepository.findById(locationId);
    if (!location) return ctx.answerCallbackQuery("Location not found");

    ctx.session.taskCreation.locationId = locationId;
    ctx.session.taskCreation.locationName = `${location.name} (${location.city})`;
    ctx.session.taskCreation.step = "selecting_staff";

    const staff = await staffRepository.findByLocation(locationId);
    const keyboard = new InlineKeyboard();
    const selectedIds = ctx.session.taskCreation.selectedStaffIds || [];

    for (const s of staff) {
        const name = formatStaffName(s.fullName);
        const isSelected = selectedIds.includes(s.id);
        const icon = isSelected ? "✅" : "☐";
        keyboard.text(`${icon} ${name}`, `tas_st_tg_${s.id}`).row();
    }

    if (selectedIds.length > 0) keyboard.text("➡️ Done", "tas_st_done").row();
    keyboard.text("⬅️ Back", `tas_city_${ctx.session.taskCreation.city}`);

    await ScreenManager.renderScreen(
        ctx,
        `📅 Date: ${ctx.session.taskCreation.date}\n📍 Location: ${ctx.session.taskCreation.locationName}\n👤 <b>Select staff (multi-select):</b>`,
        keyboard,
        { pushToStack: true }
    );
    await ctx.answerCallbackQuery();
});

// Обробник перемикання співробітника
composer.callbackQuery(/^tas_st_tg_/, async (ctx) => {
    const staffId = ctx.callbackQuery.data.replace("tas_st_tg_", "");
    if (!ctx.session.taskCreation) return ctx.answerCallbackQuery("Session lost");

    if (!ctx.session.taskCreation.selectedStaffIds) ctx.session.taskCreation.selectedStaffIds = [];
    const index = ctx.session.taskCreation.selectedStaffIds.indexOf(staffId);
    if (index === -1) ctx.session.taskCreation.selectedStaffIds.push(staffId);
    else ctx.session.taskCreation.selectedStaffIds.splice(index, 1);

    const staff = await staffRepository.findByLocation(ctx.session.taskCreation.locationId || "");
    const keyboard = new InlineKeyboard();
    const selectedIds = ctx.session.taskCreation.selectedStaffIds;

    for (const s of staff) {
        const name = formatStaffName(s.fullName);
        const isSelected = selectedIds.includes(s.id);
        const icon = isSelected ? "✅" : "☐";
        keyboard.text(`${icon} ${name}`, `tas_st_tg_${s.id}`).row();
    }

    if (selectedIds.length > 0) keyboard.text("➡️ Done", "tas_st_done").row();
    keyboard.text("⬅️ Back", `tas_loc_${ctx.session.taskCreation.locationId}`);

    await ScreenManager.renderScreen(
        ctx,
        `📅 Date: ${ctx.session.taskCreation.date}\n📍 Location: ${ctx.session.taskCreation.locationName}\n👤 <b>Select staff (${selectedIds.length} selected):</b>`,
        keyboard
    );
    await ctx.answerCallbackQuery();
});

// Обробник завершення вибору співробітників
composer.callbackQuery("tas_st_done", async (ctx) => {
    if (!ctx.session.taskCreation || !ctx.session.taskCreation.selectedStaffIds || ctx.session.taskCreation.selectedStaffIds.length === 0) {
        return ctx.answerCallbackQuery("Select at least one staff!");
    }

    const selectedStaff = await staffRepository.findManyByIds(ctx.session.taskCreation.selectedStaffIds);
    const names = selectedStaff.map(s => formatStaffName(s.fullName)).join(", ");
    ctx.session.taskCreation.staffName = names.length > 30 ? `${selectedStaff.length} photographers` : names;
    ctx.session.taskCreation.step = "entering_text";

    const keyboard = new InlineKeyboard().text("⬅️ Back", `tas_loc_${ctx.session.taskCreation.locationId}`);
    await ScreenManager.renderScreen(
        ctx,
        `📝 <b>Enter task for ${ctx.session.taskCreation.staffName}:</b>\n\n<i>You can add <b>photo</b> or <b>file</b> to the task.</i>`,
        keyboard,
        { pushToStack: true }
    );
    await ctx.answerCallbackQuery();
});

// Helper to handle task text and media
async function handleTaskInput(ctx: MyContext, text?: string, fileId?: string) {
    if (!ctx.session.taskCreation || ctx.session.taskCreation.step !== "entering_text") return;

    const taskText = text || ctx.message?.caption || "";
    if (!taskText && !fileId) {
        await ctx.reply("❌ Task text or file is required.");
        return;
    }

    ctx.session.taskCreation.taskText = taskText;
    ctx.session.taskCreation.fileId = fileId || null;
    ctx.session.taskCreation.step = "setting_time";

    const dateStr = ctx.session.taskCreation.date!;
    const prettyDate = dateStr.split("-").reverse().slice(0, 2).join(".");

    const keyboard = new InlineKeyboard();
    keyboard.text("🌑 End of day", "tas_time_23:59")
    keyboard.text("⏩ No time", "tas_time_none").row();
    keyboard.text("📝 Edit text", "tas_edit_text")
    keyboard.text("📅 Change date", "tas_change_date").row();
    keyboard.text("❌ Cancel", "task_creation_cancel");

    await ScreenManager.renderScreen(
        ctx,
        `📍 Task for ${ctx.session.taskCreation.staffName}:\n<i>${taskText || "[Media]"}</i>\n📅 <b>Date:</b> ${prettyDate}\n\n⏰ <b>Set deadline (e.g. 15:00):</b>`,
        keyboard,
        { pushToStack: true }
    );
}

// Helper to execute task creation and notification
async function executeTaskCreation(ctx: MyContext, time: string | null) {
    if (!ctx.session.taskCreation) return;

    const staffIds = ctx.session.taskCreation.selectedStaffIds || [];
    if (staffIds.length === 0 && ctx.session.taskCreation.staffId) staffIds.push(ctx.session.taskCreation.staffId);
    if (staffIds.length === 0) return ctx.reply("❌ No staff selected!");

    ctx.session.taskCreation.deadlineTime = time === "none" ? null : time;
    const results: { name: string, success: boolean, error?: string }[] = [];

    try {
        const staffList = await staffRepository.findManyByIds(staffIds);
        for (const staffId of staffIds) {
            if (!ctx.session.taskCreation) break;
            const currentStaff = staffList.find(s => s.id === staffId);
            const city = ctx.session.taskCreation.city || currentStaff?.location?.city || "Other";
            const locationName = ctx.session.taskCreation.locationName || currentStaff?.location?.name || "No location";
            const displayName = formatStaffName(currentStaff?.fullName || "Staff");

            const task = await taskService.createTask({
                staffId,
                taskText: ctx.session.taskCreation.taskText!,
                workDate: new Date(ctx.session.taskCreation.date!),
                deadlineTime: ctx.session.taskCreation.deadlineTime,
                city: city,
                locationName: locationName,
                fileId: ctx.session.taskCreation.fileId || null,
                createdById: ctx.from!.id.toString(),
            });

            const staffTelegramId = currentStaff?.user?.telegramId;
            if (!staffTelegramId) {
                results.push({ name: displayName, success: false, error: "No Telegram ID linked" });
                continue;
            }

            const deadlineText = task.deadlineTime ? `\n⏰ Дедлайн: ${task.deadlineTime}` : "";
            const taskMessage = `✨ <b>Нове завдання!</b> 📋\n\n${task.taskText}\n\n📅 Дата: ${new Date(task.workDate!).toLocaleDateString("uk-UA")}${deadlineText}\n\nБажаю успіхів! Ти впораєшся! 💖`;
            const staffKb = new InlineKeyboard().text("🏠 Меню", "staff_hub_nav");

            try {
                if (task.fileId) await ctx.api.sendPhoto(Number(staffTelegramId), task.fileId, { caption: taskMessage, parse_mode: "HTML", reply_markup: staffKb });
                else await ctx.api.sendMessage(Number(staffTelegramId), taskMessage, { parse_mode: "HTML", reply_markup: staffKb });
                results.push({ name: displayName, success: true });
            } catch (error: any) {
                results.push({ name: displayName, success: false, error: error.message });
            }
        }

        const createdTaskDate = ctx.session.taskCreation.date || new Date().toISOString().split("T")[0];
        delete ctx.session.taskCreation;

        let successText = `✅ <b>Tasks created successfully (${staffIds.length})!</b>\n\n`;
        const failed = results.filter(r => !r.success);
        if (failed.length === 0) successText += `All selected staff members have been notified.`;
        else {
            successText += `⚠️ <b>Delivery issues:</b>\n`;
            failed.forEach(f => { successText += `• ${f.name}: Not notified (bot might be blocked)\n`; });
        }

        const kb = new InlineKeyboard()
            .text("⬅️ To Dashboard", `task_dash_${createdTaskDate}`)
            .text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities").row()
            .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
        await ScreenManager.renderScreen(ctx, successText, kb);
    } catch (error) {
        logger.error({ err: error }, "Error creating task");
        const errKb = new InlineKeyboard()
            .text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities")
            .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
        await ScreenManager.renderScreen(ctx, "❌ Error creating tasks. Please try again.", errKb);
    }
}

// Helper to check role securely
async function checkTaskCreationRole(ctx: MyContext): Promise<boolean> {
    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    return hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT');
}

composer.on("message:text", async (ctx, next) => {
    const step = ctx.session.taskCreation?.step;
    if (ctx.chat?.type !== "private") return await next();
    if (ctx.session.adminFlow !== 'TASK') return await next();

    if (step === "entering_text" || step === "setting_time") {
        await ctx.deleteMessage().catch(() => {});
        if (!await checkTaskCreationRole(ctx)) {
            delete ctx.session.taskCreation;
            const errKb = new InlineKeyboard()
                .text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities")
                .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
            return await ScreenManager.renderScreen(ctx, "❌ Access Denied", errKb);
        }
        
        if (step === "entering_text") await handleTaskInput(ctx, ctx.message.text);
        else {
            const timeInput = ctx.message.text.trim();
            if (/^\d{1,2}:\d{2}$/.test(timeInput)) await executeTaskCreation(ctx, timeInput);
            else await ScreenManager.renderScreen(ctx, "❌ Невірний формат часу. Введіть HH:MM (наприклад, 15:00) або скористайтеся кнопками:");
        }
    } else await next();
});


composer.on("message:photo", async (ctx, next) => {
    if (ctx.session.taskCreation?.step === "entering_text" && ctx.chat?.type === "private") {
        await ctx.deleteMessage().catch(() => {});
        if (!await checkTaskCreationRole(ctx)) return;
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        await handleTaskInput(ctx, ctx.message.caption, photo?.file_id);
    } else await next();
});

composer.on("message:document", async (ctx, next) => {
    if (ctx.session.taskCreation?.step === "entering_text" && ctx.chat?.type === "private") {
        await ctx.deleteMessage().catch(() => {});
        if (!await checkTaskCreationRole(ctx)) return;
        await handleTaskInput(ctx, ctx.message.caption, ctx.message.document.file_id);
    } else await next();
});

// Обробник встановлення часу
composer.callbackQuery(/^tas_time_/, async (ctx) => {
    const time = ctx.callbackQuery.data.replace("tas_time_", "");
    await executeTaskCreation(ctx, time);
    await ctx.answerCallbackQuery();
});

// Обробник редагування тексту
composer.callbackQuery("tas_edit_text", async (ctx) => {
    if (!ctx.session.taskCreation) return ctx.answerCallbackQuery("Session lost");
    ctx.session.taskCreation.step = "entering_text";
    const keyboard = new InlineKeyboard().text("⬅️ Back", `tas_loc_${ctx.session.taskCreation.locationId}`);
    await ScreenManager.renderScreen(
        ctx,
        `📝 <b>Correct task for ${ctx.session.taskCreation.staffName}:</b>\n\n<i>Current text:</i> ${ctx.session.taskCreation.taskText || "[Media]"}`,
        keyboard,
        { pushToStack: true }
    );
    await ctx.answerCallbackQuery();
});

// Обробник зміни дати
composer.callbackQuery("tas_change_date", async (ctx) => {
    const keyboard = new InlineKeyboard();
    build14DayCalendar("tas_d_").forEach(row => keyboard.row(...row));
    const backCall = ctx.session.taskCreation?.taskText ? "tas_edit_done_back" : "task_add_start";
    keyboard.text("⬅️ Back", backCall);
    await ScreenManager.renderScreen(ctx, "📅 <b>Select NEW execution date:</b>", keyboard, { pushToStack: true });
    await ctx.answerCallbackQuery();
});

// Кнопка Back з календаря (якщо текст вже є)
composer.callbackQuery("tas_edit_done_back", async (ctx) => {
    if (!ctx.session.taskCreation) return ctx.answerCallbackQuery("Session lost");
    const dateStr = ctx.session.taskCreation.date!;
    const prettyDate = dateStr.split("-").reverse().slice(0, 2).join(".");
    const keyboard = new InlineKeyboard();
    keyboard.text("🌑 End of day", "tas_time_23:59").text("⏩ No time", "task_time_none").row();
    keyboard.text("📝 Edit text", "tas_edit_text").text("📅 Change date", "tas_change_date").row();
    keyboard.text("❌ Cancel", "task_creation_cancel");
    await ScreenManager.renderScreen(
        ctx,
        `📍 Task for ${ctx.session.taskCreation.staffName}:\n<i>${ctx.session.taskCreation.taskText || "[Media]"}</i>\n📅 <b>Date:</b> ${prettyDate}\n\n⏰ <b>Set deadline (e.g. 15:00):</b>`,
        keyboard
    );
    await ctx.answerCallbackQuery();
});

// Обробник скасування
composer.callbackQuery("task_creation_cancel", async (ctx) => {
    delete ctx.session.taskCreation;
    const kb = new InlineKeyboard()
        .text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities")
        .text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
    await ScreenManager.renderScreen(ctx, "❌ Task creation cancelled.", kb);
    await ctx.answerCallbackQuery();
});

export default composer;
