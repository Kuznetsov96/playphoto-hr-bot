import { STAFF_TEXTS } from "../../../constants/staff-texts.js";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../../types/context.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { supportRepository } from "../../../repositories/support-repository.js";
import { staffService } from "../services/index.js";
import { taskService } from "../../../services/task-service.js";
import { truncateText } from "../../../utils/task-helpers.js";
import { ScreenManager } from "../../../utils/screen-manager.js";
import logger from "../../../core/logger.js";

export const staffHandlers = new Composer<MyContext>();

/**
 * Entry point for active photographers (Main Hub)
 */
export async function showStaffHub(ctx: MyContext, forceNew: boolean = false) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    logger.info({ telegramId }, "👤 Accessing Staff Hub...");
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    const isNewCandidate = user?.candidate?.status === 'AWAITING_FIRST_SHIFT';

    logger.debug({ 
        telegramId, 
        hasStaffProfile: !!user?.staffProfile, 
        isActive: user?.staffProfile?.isActive,
        isNewCandidate 
    }, "🔍 showStaffHub state");

    if (!user || (!user.staffProfile?.isActive && !isNewCandidate)) {
        logger.warn({ telegramId }, "🚫 Access denied to Staff Hub");
        return ctx.reply("У тебе немає доступу до меню фотографа. 🌸");
    }

    // --- Shift info ---
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    kyivNow.setHours(0, 0, 0, 0);

    const staffProfileId = user.staffProfile?.id;
    const todayShifts = staffProfileId ? await workShiftRepository.findWithLocationForStaff(staffProfileId, kyivNow, 1) : [];
    const hasShiftToday = todayShifts.length > 0 && todayShifts[0]?.date.getTime() === kyivNow.getTime();

    // Check if it's a completely new user without any schedule yet
    const allShifts = staffProfileId ? await workShiftRepository.findWithLocationForStaff(staffProfileId, new Date(0), 1) : [];
    
    const { getUserAdminRole } = await import("../../../middleware/role-check.js");
    const adminRole = await getUserAdminRole(BigInt(telegramId));
    
    const isNewHireWithoutSchedule = (isNewCandidate || allShifts.length === 0) && !adminRole;

    let shiftLine: string;
    let text: string;
    let kb = new InlineKeyboard();

    if (isNewHireWithoutSchedule) {
        // Apple Style Waiting Screen
        const KNOWLEDGE_BASE_LINK = "https://t.me/+hC9UDoSZb3hiZjFi";

        shiftLine = `⏳ <b>Твій графік готується</b>\n\n` +
            `Ми вже створюємо для тебе перші робочі зміни! ✨\n` +
            `Як тільки графік буде готовий, ти отримаєш сповіщення тут.\n\n` +
            `📖 Поки що можеш ознайомитися з нашою <b>Базою знань</b>, щоб підготуватися до першого дня.`;
        
        kb.url("📖 База знань", KNOWLEDGE_BASE_LINK).row()
          .text("💬 Підтримка", "open_support_dialog");
        
        text = `💫 <b>Вітаємо в команді PlayPhoto!</b>\n\n${shiftLine}`;
        return ScreenManager.renderScreen(ctx, text, kb, { forceNew, pushToStack: true });
    }

    if (hasShiftToday) {
        const s = todayShifts[0]!;
        const weekday = s.date.toLocaleDateString("uk-UA", { weekday: "short", timeZone: "Europe/Kyiv" });
        const dateStr = s.date.toLocaleDateString("uk-UA", {
            day: "2-digit",
            month: "2-digit",
            timeZone: "Europe/Kyiv"
        });
        const day = weekday.charAt(0).toUpperCase() + weekday.slice(1);
        shiftLine = `📸 <b>Сьогодні — ${s.location.name}</b>\n${day}, ${dateStr} · Вдалого дня! ✨`;
    } else {
        shiftLine = `🏝 <b>Сьогодні вихідний</b>\nВідпочивай та набирайся сил! ✨`;
    }

    const tasks = user.staffProfile ? await taskService.getStaffActiveTasks(user.staffProfile.id) : [];
    const activeTasksCount = tasks.filter((t) => !t.isCompleted).length;
    ctx.session.activeTasksCount = activeTasksCount; // Cache it!

    const tasksLine =
        activeTasksCount > 0
            ? `\n\n🔴 <b>${activeTasksCount} ${activeTasksCount === 1 ? "активне завдання" : "активні завдання"}</b> — переглянь у «Мої завдання»`
            : "";

    const onboardingHeader = !ctx.session.staffSeenWelcome ? `💫 <b>Ласкаво просимо в PlayPhoto!</b>\n\n` : "";
    if (!ctx.session.staffSeenWelcome) ctx.session.staffSeenWelcome = true;

    text = `${onboardingHeader}${shiftLine}${tasksLine}`;
    await ScreenManager.renderScreen(ctx, text, "staff-main", { forceNew, pushToStack: true });
}

/**
 * Show Schedule view
 */
export async function showStaffSchedule(ctx: MyContext) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user || !user.staffProfile) return;

    const shifts = await workShiftRepository.findWithLocationForStaff(user.staffProfile.id, new Date(), 100);

    if (shifts.length === 0) {
        const text = "У тебе поки немає призначених змін. 📅\nЯк тільки вони з'являться — я повідомлю!";
        return ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"));
    }

    let text = "📅 <b>Твій графік на найближчий час:</b>\n\n";
    const shiftsToQuery = shifts.map((s) => ({ locationId: s.locationId, date: s.date }));
    const allColleagues = await workShiftRepository.findColleaguesForShifts(user.staffProfile.id, shiftsToQuery);

    for (const s of shifts) {
        const raw = s.date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", weekday: "short" });
        const dateStr = raw.charAt(0).toUpperCase() + raw.slice(1);
        text += `▫️ <code>${dateStr}</code> — ${s.location.name}`;

        const sStart = new Date(s.date);
        sStart.setHours(0, 0, 0, 0);
        const sEnd = new Date(s.date);
        sEnd.setHours(23, 59, 59, 999);
        const colleagues = allColleagues.filter(
            (c) => c.locationId === s.locationId && c.date >= sStart && c.date <= sEnd
        );

        if (colleagues.length > 0) {
            const links = colleagues.map((c) => {
                const name = staffService.formatStaffName(c.staff.fullName);
                const username = c.staff.user?.username;
                const tgId = c.staff.user?.telegramId;
                if (username) return `<a href="https://t.me/${username}">${name}</a>`;
                if (tgId) return `<a href="tg://user?id=${tgId}">${name}</a>`;
                return name;
            });
            text += ` (${links.join(", ")})`;
        }
        text += `\n`;
    }

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), {
        pushToStack: true
    });
    await ctx.answerCallbackQuery().catch(() => {});
}

/**
 * Show Tasks view
 */
export async function showStaffTasks(ctx: MyContext, forceNew: boolean = false) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user || !user.staffProfile) return;

    const tasks = await taskService.getStaffActiveTasks(user.staffProfile.id);

    if (tasks.length === 0) {
        const text = `✨ <b>Ти супер! Всі завдання виконано!</b> 🎉\n\nВідпочивай та набирайся сил! 💖`;
        return ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), {
            forceNew,
            pushToStack: true
        });
    }

    let text = `📋 <b>Твої активні завдання:</b>\n\n`;
    const kb = new InlineKeyboard();

    tasks.forEach((task: any, index: number) => {
        const status = task.isCompleted ? "✅" : "⏳";
        const deadline = task.deadlineTime ? ` (до ${task.deadlineTime})` : "";
        text += `${index + 1}. ${status} ${truncateText(task.taskText, 100)}${deadline}\n\n`;

        if (!task.isCompleted) {
            kb.text(`🏁 Виконати #${index + 1}`, `staff_task_toggle_${task.id}`)
                .text(`❓ Питання`, `staff_task_help_${task.id}`)
                .row();
        } else {
            kb.text(`✅ Виконано #${index + 1}`, `staff_task_toggle_${task.id}`).row();
        }
    });

    text += `<i>Натискай на кнопки, щоб відмітити виконання!</i> ✨`;
    kb.text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(ctx, text, kb, { forceNew, pushToStack: true });
    await ctx.answerCallbackQuery().catch(() => {});
}

/**
 * Show Logistics (Parcels) view
 */
export async function showStaffLogistics(ctx: MyContext) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user || !user.staffProfile) return;

    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    kyivNow.setHours(0, 0, 0, 0);

    const todayShifts = await workShiftRepository.findWithLocationForStaff(user.staffProfile.id, kyivNow, 1);
    if (todayShifts.length === 0 || todayShifts[0]?.date.getTime() !== kyivNow.getTime()) {
        const text = "У тебе сьогодні немає зміни на жодній локації. 🏝";
        return ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), { pushToStack: true });
    }

    const shift = todayShifts[0]!;
    const prisma = (await import("../../../db/core.js")).default;
    const parcels = await prisma.parcel.findMany({
        where: {
            locationId: shift.locationId,
            OR: [
                { status: { in: ['EXPECTED', 'ARRIVED'] } },
                { status: 'DELIVERED', deliveryType: 'Address', contentPhotoId: null }
            ]
        },
        orderBy: { createdAt: 'desc' }
    });

    if (parcels.length === 0) {
        const text = `📭 <b>На вашій локації (${shift.location.name}) зараз немає активних відправлень.</b>`;
        return ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), { pushToStack: true });
    }

    let text = `📦 <b>Посилки на локації ${shift.location.name}:</b>\n\n`;
    const kb = new InlineKeyboard();

    parcels.forEach((parcel: any, index: number) => {
        let statusEmoji = "📦";
        let statusText = "Очікується";
        if (parcel.status === 'ARRIVED') { statusEmoji = "🏢"; statusText = "У відділенні/поштоматі"; }
        if (parcel.status === 'DELIVERED') { statusEmoji = "🚚"; statusText = "Доставлено кур'єром"; }

        text += `${index + 1}. ${statusEmoji} <b>ТТН:</b> <code>${parcel.ttn}</code>\n`;
        text += `   <b>Статус:</b> ${statusText}\n`;
        if (parcel.description) text += `   <b>Вміст:</b> ${parcel.description}\n`;
        if (parcel.rejectionCount > 0) text += `   ⚠️ <i>Відмов: ${parcel.rejectionCount}</i>\n`;
        text += `\n`;

        if (parcel.status === 'ARRIVED') {
            kb.text(`✅ Забрати #${index + 1}`, `parcel_accept_${parcel.id}`)
              .text(`❌ Відмовитись`, `parcel_reject_${parcel.id}`).row();
        } else if (parcel.status === 'DELIVERED') {
            kb.text(`📸 Додати фото вмісту #${index + 1}`, `parcel_photo_${parcel.id}`).row();
        }
    });

    text += `<i>Оберіть посилку, щоб підтвердити отримання.</i> ✨`;
    kb.text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

/**
 * Shared logic to start support flow from menu
 */
export async function startSupportFlow(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    logger.info({ telegramId }, "🚀 Starting support flow...");
    const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));
    
    if (!user) {
        logger.error({ telegramId }, "❌ User not found in startSupportFlow");
        return ctx.reply("Помилка: користувача не знайдено. Спробуй натиснути /start.");
    }

    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);
    if (activeTicket) {
        if (ctx.callbackQuery)
            await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-processing"]).catch(() => {});
        await ScreenManager.renderScreen(
            ctx,
            STAFF_TEXTS["support-info-already-open"],
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav")
        );
        return;
    }

    const activeOutgoingTopic = await supportRepository.findActiveOutgoingTopicByUser(user.id);
    if (activeOutgoingTopic) {
        if (ctx.callbackQuery)
            await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-processing"]).catch(() => {});
        await ScreenManager.renderScreen(
            ctx,
            "💬 <b>Обговорення відкрито:</b>\nАдміністратор створив діалог з тобою. Просто напиши повідомлення сюди, і я його передам.",
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav")
        );
        return;
    }

    ctx.session.step = "create_ticket";
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    
    const isNewCandidate = user.candidate?.status === 'AWAITING_FIRST_SHIFT' && !user.staffProfile;
    const cancelCallback = isNewCandidate ? "staff_hub_nav" : "staff_hub_nav"; 
    // Both point to staff_hub_nav, but showStaffHub logic will handle the redirect correctly.
    // To be extra safe and avoid any "refresh" loops, we ensure the text is clear.

    const text = STAFF_TEXTS["support-ask-issue"];

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("❌ Скасувати", cancelCallback), {
        pushToStack: true
    });
}

// --- HANDLERS ---

staffHandlers.command("support", async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    await startSupportFlow(ctx);
});

staffHandlers.callbackQuery("open_support_dialog", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startSupportFlow(ctx);
});

staffHandlers.callbackQuery("staff_hub_tasks_redirect", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStaffTasks(ctx, true);
});

staffHandlers.callbackQuery(/^staff_task_toggle_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    await taskService.toggleTaskStatus(taskId);
    await showStaffTasks(ctx);
    await ctx.answerCallbackQuery("Статус змінено! ✨").catch(() => {});
});

staffHandlers.callbackQuery(/^staff_task_help_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const task = await taskService.getTaskById(taskId);
    if (!task) return ctx.answerCallbackQuery("Завдання не знайдено.");

    ctx.session.step = "create_ticket";
    ctx.session.clarificationTaskId = taskId;

    const text =
        `❓ <b>Уточнення по завданню:</b>\n\n` +
        `<i>"${truncateText(task.taskText, 100)}"</i>\n\n` +
        `Напиши, що саме незрозуміло, і я передам твої слова адміну. ✍️`;

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("❌ Скасувати", "staff_hub_nav"), {
        pushToStack: true
    });
    await ctx.answerCallbackQuery();
});
