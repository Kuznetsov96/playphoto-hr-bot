import { STAFF_TEXTS } from "../../../constants/staff-texts.js";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../../types/context.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { staffService } from "../services/index.js";
import { taskService } from "../../../services/task-service.js";
import { taskProofService, mapTelegramMessageToTaskProofInput } from "../../../services/task-proof-service.js";
import { truncateText } from "../../../utils/task-helpers.js";
import { ScreenManager } from "../../../utils/screen-manager.js";
import { escapeHtml, htmlToPlainText } from "../../../handlers/admin/utils.js";
import logger from "../../../core/logger.js";
import { buildSignedCallback } from "../../../utils/signed-callback.js";
import { TEAM_CHATS } from "../../../config.js";
import { shortenName } from "../../../utils/string-utils.js";
import { formatLocationLabel, getLocationShortcut } from "../../../utils/ticket-card.js";
import { formatShiftLocationLabel } from "../../../utils/logistics-formatters.js";
import { firstShiftOnboardingService } from "../../../services/first-shift-onboarding-service.js";
import { replacementService } from "../../../services/replacement-service.js";
import { getShiftTimeFromLocationSchedule } from "../../../utils/shift-time.js";
import { getShiftTimeFromOpeningHours, type OpeningHoursDay } from "../../../utils/location-opening-hours.js";
import { supportConversationService } from "../../../services/support-conversation-service.js";
import { logBusinessEvent } from "../../../core/log-events.js";
import { getVisibleStaffShifts } from "../services/staff-schedule-view.js";

export const staffHandlers = new Composer<MyContext>();
const TASK_PROOF_BLOCKED_STEPS = new Set([
    "support_chat",
    "create_ticket",
    "broadcast_decline_reason",
    "reply_and_close",
]);

function formatShiftColleague(fullName: string, username?: string | null, telegramId?: bigint | null): string {
    const parts = fullName.trim().split(/\s+/);
    const surname = parts[0] || "Колега";
    const firstInitial = parts[1]?.charAt(0) || "";
    const shortName = firstInitial ? `${surname} ${firstInitial}.` : surname;
    const escapedLabel = escapeHtml(shortName);

    if (username && username.length < 32 && !username.includes('/') && !username.includes('\\')) {
        return `<a href="https://t.me/${username}">${escapedLabel}</a>`;
    }

    if (telegramId) {
        return `<a href="tg://user?id=${telegramId.toString()}">${escapedLabel}</a>`;
    }

    return escapedLabel;
}

function formatShiftClock(date: Date) {
    return date.toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Kyiv"
    });
}

/**
 * Shift times, most authoritative source first:
 *   1. the shift's own start/end, as planned in the webapp;
 *   2. the location's canonical opening hours for that weekday;
 *   3. the legacy hand-seeded text schedule, for locations not yet migrated.
 *
 * Never fall back to an invented default — an unknown time must read as "not set".
 */
function formatStaffShiftTime(shift: {
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
        || "час не вказано";
}

function buildTaskProofKeyboard(taskId: string) {
    return new InlineKeyboard()
        .text("✅ Завершити завдання", `staff_task_proof_submit_${taskId}`).row()
        .text("✖️ Скасувати", `staff_task_proof_cancel_${taskId}`).danger();
}

function buildTaskProofText(taskText: string, proofCount: number) {
    const proofLine = proofCount > 0
        ? `\n\n📦 <b>Збережено елементів:</b> ${proofCount}`
        : "";

    return (
        `📎 <b>Надішли підтвердження до завдання:</b>\n\n` +
        `${taskText}\n\n` +
        `Можна надсилати текст, фото, відео, файли, голосові або кілька повідомлень підряд.` +
        `${proofLine}\n\n` +
        `Коли все надішлеш, натисни <b>«Завершити завдання»</b>.`
    );
}

async function renderTaskProofScreen(
    ctx: MyContext,
    taskId: string,
    taskText: string,
    proofCount: number,
    pushToStack: boolean = false,
) {
    await ScreenManager.renderScreen(
        ctx,
        buildTaskProofText(taskText, proofCount),
        buildTaskProofKeyboard(taskId),
        { forceNew: true, pushToStack }
    );
}

/**
 * Entry point for active photographers (Main Hub)
 */
export async function showStaffHub(ctx: MyContext, forceNew: boolean = false) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    const isNewCandidate = user?.candidate?.status === 'AWAITING_FIRST_SHIFT';

    logger.debug({
        telegramId,
        hasStaffProfile: !!user?.staffProfile,
        isActive: user?.staffProfile?.isActive,
        isNewCandidate
    }, "Staff hub state evaluated");

    if (!user || (!user.staffProfile?.isActive && !isNewCandidate)) {
        logger.warn({ telegramId }, "Staff hub access denied");
        return ctx.reply("У тебе немає доступу до меню фотографа. 🌸");
    }

    // --- Shift info ---
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    kyivNow.setHours(0, 0, 0, 0);

    const staffProfileId = user.staffProfile?.id;
    const upcomingShifts = staffProfileId ? await getVisibleStaffShifts(staffProfileId, kyivNow, 10) : [];
    const todayShifts = upcomingShifts.filter((shift) => shift.date.getTime() === kyivNow.getTime());
    const hasShiftToday = todayShifts.length > 0;

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
        const shift = todayShifts[0]!;
        shiftLine =
            `📸 <b>Сьогодні зміна</b>\n` +
            `${escapeHtml(formatShiftLocationLabel(shift.location))} · ${escapeHtml(formatStaffShiftTime(shift))}` +
            (shift.isReplacementSearchActive
                ? `\n${STAFF_TEXTS["staff-replacement-search-active-hub"]}`
                : shift.isAcceptedReplacementPendingSync
                ? `\n${STAFF_TEXTS["staff-replacement-pending-sync-hub"]}`
                : "");
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

    const now = new Date();
    const kyivToday = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    kyivToday.setHours(0, 0, 0, 0);

    const shifts = await getVisibleStaffShifts(user.staffProfile.id, kyivToday, 100, {
        shadowRead: true,
        canonicalRead: true
    });

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
        text += `▫️ <code>${dateStr}</code> · ${escapeHtml(formatStaffShiftTime(s))} · ${escapeHtml(formatShiftLocationLabel(s.location))}`;
        if (s.isReplacementSearchActive) {
            text += ` · ${STAFF_TEXTS["staff-replacement-search-active-schedule"]}`;
        } else if (s.isAcceptedReplacementPendingSync) {
            text += ` · ${STAFF_TEXTS["staff-replacement-pending-sync-schedule"]}`;
        }

        const colleagues = allColleagues.filter(
            (c) => c.locationId === s.locationId && c.date.getTime() === s.date.getTime()
        );

        if (colleagues.length === 1) {
            const names = colleagues.map((c) => formatShiftColleague(
                c.staff.fullName,
                c.staff.user?.username,
                c.staff.user?.telegramId ?? null
            ));
            text += ` (${names.join(", ")})`;
        }
        text += `\n`;
    }

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), {
        pushToStack: true
    });
    await ctx.answerCallbackQuery().catch(() => { });
}

export async function showReplacementShiftPicker(ctx: MyContext) {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return;

    const shifts = await replacementService.listSelectableShifts(user.staffProfile.id);
    if (shifts.length === 0) {
        await ScreenManager.renderScreen(
            ctx,
            "У тебе немає майбутніх змін, для яких можна запустити пошук підміни.",
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"),
            { pushToStack: true }
        );
        await ctx.answerCallbackQuery().catch(() => { });
        return;
    }

    const kb = new InlineKeyboard();
    for (const shift of shifts.slice(0, 8)) {
        kb.text(replacementService.formatShiftButtonLabel(shift), `staff_repl_pick_${shift.id}`).row();
    }
    kb.text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(
        ctx,
        "Оберіть дату і локацію.",
        kb,
        { pushToStack: true }
    );
    await ctx.answerCallbackQuery().catch(() => { });
}

async function showReplacementConfirmation(ctx: MyContext, shiftId: string) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return;

    const shifts = await replacementService.listSelectableShifts(user.staffProfile.id);
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift) {
        await ctx.answerCallbackQuery("Ця зміна вже недоступна.").catch(() => { });
        await showReplacementShiftPicker(ctx);
        return;
    }

    const kb = new InlineKeyboard()
        .text("Почати пошук", `staff_repl_start_${shift.id}`).row()
        .text("⬅️ Назад", "staff_repl_open")
        .text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(ctx, replacementService.formatConfirmationText(shift), kb, { pushToStack: true });
    await ctx.answerCallbackQuery().catch(() => { });
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
        text += `${index + 1}. ${status}${deadline}\n${task.taskText}\n\n`;

        if (!task.isCompleted) {
            if (task.completionMode === "PROOF_REQUIRED") {
                kb.text(`📤 Надіслати підтвердження #${index + 1}`, `staff_task_proof_start_${task.id}`)
                    .text(`❓ Питання`, `staff_task_help_${task.id}`)
                    .row();
            } else {
                kb.text(`🏁 Виконати #${index + 1}`, `staff_task_toggle_${task.id}`)
                    .text(`❓ Питання`, `staff_task_help_${task.id}`)
                    .row();
            }
        } else {
            if (task.completionMode === "PROOF_REQUIRED") {
                text += `   📎 <i>Підтвердження надіслано</i>\n\n`;
            } else {
                kb.text(`✅ Виконано #${index + 1}`, `staff_task_toggle_${task.id}`).row();
            }
        }
    });

    text += `<i>Натискай на кнопки, щоб відмітити виконання!</i> ✨`;
    kb.text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(ctx, text, kb, { forceNew, pushToStack: true });
    await ctx.answerCallbackQuery().catch(() => { });
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
                { status: 'DELIVERED', contentPhotoIds: { isEmpty: true } }
            ]
        },
        orderBy: { createdAt: 'desc' }
    });

    if (parcels.length === 0) {
        const text = `📭 <b>На вашій локації (${escapeHtml(formatShiftLocationLabel(shift.location))}) зараз немає активних відправлень.</b>`;
        return ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), { pushToStack: true });
    }

    let text = `📦 <b>Посилки на локації ${escapeHtml(formatShiftLocationLabel(shift.location))}:</b>\n\n`;
    const kb = new InlineKeyboard();

    parcels.forEach((parcel: any, index: number) => {
        let statusEmoji = "📦";
        let statusText = "Очікується";
        if (parcel.status === 'ARRIVED') { statusEmoji = "🏢"; statusText = "У відділенні/поштоматі"; }
        if (parcel.status === 'DELIVERED') {
            statusEmoji = parcel.deliveryType === 'Address' ? "🚚" : "📬";
            statusText = parcel.deliveryType === 'Address' ? "Доставлено кур'єром" : "Вже видано Новою Поштою";
        }

        text += `${index + 1}. ${statusEmoji} <b>ТТН:</b> <code>${parcel.ttn}</code>\n`;
        text += `   <b>Статус:</b> ${statusText}\n`;
        if (parcel.description) text += `   <b>Вміст:</b> ${parcel.description}\n`;
        if (parcel.rejectionCount > 0) text += `   ⚠️ <i>Відмов: ${parcel.rejectionCount}</i>\n`;
        text += `\n`;

        if (parcel.status === 'ARRIVED') {
            kb.text(`✅ Забрати #${index + 1}`, `parcel_accept_${parcel.id}`)
                .text(`❌ Відмовитись`, buildSignedCallback("prj", parcel.id)).danger().row();
        } else if (parcel.status === 'DELIVERED') {
            kb.text(`📸 Додати фото вмісту #${index + 1}`, buildSignedCallback("pph", parcel.id)).row();
        }
    });

    text += `<i>Оберіть посилку, щоб підтвердити отримання.</i> ✨`;
    kb.text("🏠 Меню", "staff_hub_nav");

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

async function notifySupportAboutTaskProof(ctx: MyContext, submission: Awaited<ReturnType<typeof taskProofService.submitDraft>>) {
    if (!TEAM_CHATS.SUPPORT) return;

    const task = submission.task;
    const staff = submission.staff;
    const shortStaffName = shortenName(staff.fullName);
    const locationName = task.locationName || staff.location?.name || null;
    const locationCity = task.city || staff.location?.city || null;
    const locationLabel = locationName ? formatLocationLabel(locationName, locationCity) : "Локація не вказана";
    const workDateLabel = task.workDate
        ? task.workDate.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })
        : "Без дати";
    const topicDateLabel = task.workDate
        ? task.workDate.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })
        : "??.??";
    const locationCode = locationName ? getLocationShortcut(locationName, locationCity) : "Task";
    const topicTitle = `📎 ${locationCode} | ${shortStaffName} | ${topicDateLabel}`;

    let topicId = submission.supportTopicId ?? null;
    if (!topicId || submission.supportTopicStatus === "CLOSED") {
        try {
            const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);
            topicId = topic.message_thread_id;
            await taskProofService.attachSupportTopic(submission.id, BigInt(TEAM_CHATS.SUPPORT), topicId);
        } catch (err) {
            logger.warn({ err, taskId: task.id }, "Task proof topic creation failed");
            return;
        }
    }

    const taskPreview = htmlToPlainText(task.taskText);
    const topicHeader =
        `📎 <b>Task Proof</b>\n` +
        `👤 <b>${escapeHtml(shortStaffName)}</b>\n` +
        `📍 <b>${escapeHtml(locationLabel)}</b>\n` +
        `📅 <b>${escapeHtml(workDateLabel)}</b>\n` +
        (task.deadlineTime ? `🕐 <b>До ${escapeHtml(task.deadlineTime)}</b>\n` : "") +
        `\n<i>${escapeHtml(truncateText(taskPreview, 250))}</i>\n\n` +
        `<i>Відповідь у цьому треді буде доставлена фотографу.</i>`;

    await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, topicHeader, {
        parse_mode: "HTML",
        message_thread_id: topicId,
        reply_markup: new InlineKeyboard().text("✅ Закрити уточнення", `task_proof_close_${submission.id}`),
    }).catch((err) => {
        logger.warn({ err, taskId: task.id, topicId }, "Task proof summary delivery to support topic failed");
    });

    for (const item of submission.items) {
        try {
            if (item.type === "TEXT" && item.text) {
                await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, `📝 ${escapeHtml(item.text)}`, {
                    parse_mode: "HTML",
                    message_thread_id: topicId,
                });
                continue;
            }

            const caption = item.caption ? escapeHtml(item.caption) : undefined;
            if (!item.telegramFileId) continue;

            if (item.type === "PHOTO") {
                await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    ...(caption ? { caption, parse_mode: "HTML" } : {}),
                    message_thread_id: topicId,
                });
            } else if (item.type === "VIDEO") {
                await ctx.api.sendVideo(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    ...(caption ? { caption, parse_mode: "HTML" } : {}),
                    message_thread_id: topicId,
                });
            } else if (item.type === "DOCUMENT") {
                await ctx.api.sendDocument(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    ...(caption ? { caption, parse_mode: "HTML" } : {}),
                    message_thread_id: topicId,
                });
            } else if (item.type === "VOICE") {
                await ctx.api.sendVoice(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    message_thread_id: topicId,
                });
            } else if (item.type === "AUDIO") {
                await ctx.api.sendAudio(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    ...(caption ? { caption, parse_mode: "HTML" } : {}),
                    message_thread_id: topicId,
                });
            } else if (item.type === "ANIMATION") {
                await ctx.api.sendAnimation(TEAM_CHATS.SUPPORT, item.telegramFileId, {
                    ...(caption ? { caption, parse_mode: "HTML" } : {}),
                    message_thread_id: topicId,
                });
            }
        } catch (err) {
            logger.warn({ err, taskId: task.id, proofItemId: item.id, topicId }, "Task proof item delivery to support topic failed");
        }
    }
}

export async function handleTaskProofMessage(ctx: MyContext): Promise<boolean> {
    if (ctx.chat?.type !== "private" || !ctx.message || !ctx.from?.id) return false;

    const currentStep = ctx.session.step || "idle";
    if (TASK_PROOF_BLOCKED_STEPS.has(currentStep)) return false;

    const telegramId = BigInt(ctx.from.id);
    const user = await userRepository.findWithStaffProfileByTelegramId(telegramId);
    const staffId = user?.staffProfile?.id;
    if (!staffId) return false;

    const stepTaskId = currentStep.startsWith("awaiting_task_proof_") &&
        !currentStep.startsWith("awaiting_task_proof_topic_reply_")
        ? currentStep.replace("awaiting_task_proof_", "")
        : null;
    const activeDraft = stepTaskId
        ? await taskProofService.getDraft(stepTaskId)
        : await taskProofService.getActiveDraftByStaffId(staffId);
    if (stepTaskId && !activeDraft) {
        ctx.session.step = "idle";
        delete ctx.session.taskProofFlow;
        return false;
    }
    if (!activeDraft) return false;

    const proofInput = mapTelegramMessageToTaskProofInput(ctx.message);
    if (!proofInput) {
        await ctx.reply("⚠️ Для підтвердження підійдуть текст, фото, відео, файл або голосове повідомлення.");
        return true;
    }

    const updated = await taskProofService.appendItem(activeDraft.taskId, staffId, proofInput);
    if (!updated) return true;

    ctx.session.step = `awaiting_task_proof_${activeDraft.taskId}`;
    ctx.session.taskProofFlow = { taskId: activeDraft.taskId };
    await renderTaskProofScreen(ctx, activeDraft.taskId, updated.task.taskText, updated.items.length);
    return true;
}

/**
 * Shared logic to start support flow from menu
 */
async function presentSupportEntry(
    ctx: MyContext,
    text: string,
    keyboard: InlineKeyboard,
    options: { pushToStack?: boolean; forceNew?: boolean } = {}
) {
    // A message written by a person is correspondence, not a disposable menu
    // screen. Never replace the source message when its Reply button is used.
    const callbackData = ctx.callbackQuery?.data;
    const isCorrespondenceReply = callbackData === "staff_support_reply" || callbackData === "contact_hr";
    if (isCorrespondenceReply && ctx.callbackQuery?.message) {
        await ctx.reply(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true }
        });
        return;
    }

    await ScreenManager.renderScreen(ctx, text, keyboard, options);
}

export async function startSupportFlow(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const activeOnboardingCase = await firstShiftOnboardingService.findActiveCaseByTelegramId(telegramId);
    if (activeOnboardingCase) {
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery("Під час онбордінгу питання йдуть у спеціальний topic.").catch(() => { });
        }
        await presentSupportEntry(
            ctx,
            "🚀 <b>Онбордінг першої зміни ще відкритий.</b>\n\nПросто напиши повідомлення сюди, і я передам його в onboarding-topic ментора.",
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"),
            { forceNew: true }
        );
        return;
    }

    const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));

    if (!user) {
        logger.error({ telegramId }, "Support flow start failed because user was not found");
        return ctx.reply("Помилка: користувача не знайдено. Спробуй натиснути /start.");
    }

    const activeConversation = await supportConversationService.resolveActive(user.id);
    if (activeConversation) {
        if (ctx.callbackQuery)
            await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-processing"]).catch(() => { });
        await presentSupportEntry(
            ctx,
            STAFF_TEXTS["support-info-already-open"],
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav")
        );
        logBusinessEvent({
            event: "support.staff_reply_prompt_opened",
            correlationId: ctx.correlationId,
            updateId: ctx.update.update_id,
            telegramId,
            userId: user.id,
            actorType: "staff",
            actorRole: "staff",
            result: "success",
            module: "staff-menu",
            operation: "startSupportFlow",
            safeContext: {
                routeKind: activeConversation.kind,
                routeId: activeConversation.id,
                topicId: activeConversation.topicId,
                sourceMessageId: ctx.callbackQuery?.message?.message_id,
            }
        });
        return;
    }

    ctx.session.step = "create_ticket";
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => { });

    const isNewCandidate = user.candidate?.status === 'AWAITING_FIRST_SHIFT' && !user.staffProfile;
    const cancelCallback = isNewCandidate ? "staff_hub_nav" : "staff_hub_nav";
    // Both point to staff_hub_nav, but showStaffHub logic will handle the redirect correctly.
    // To be extra safe and avoid any "refresh" loops, we ensure the text is clear.

    const text = STAFF_TEXTS["support-ask-issue"];

    await presentSupportEntry(ctx, text, new InlineKeyboard().text("✖️ Скасувати", cancelCallback).danger(), {
        pushToStack: true
    });
}

// --- HANDLERS ---

staffHandlers.command("support", async (ctx) => {
    await ctx.deleteMessage().catch(() => { });
    await startSupportFlow(ctx);
});

staffHandlers.callbackQuery("open_support_dialog", async (ctx) => {
    await startSupportFlow(ctx);
});

staffHandlers.callbackQuery("staff_support_reply", async (ctx) => {
    await startSupportFlow(ctx);
});

staffHandlers.callbackQuery("staff_hub_tasks_redirect", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStaffTasks(ctx, true);
});

staffHandlers.callbackQuery("staff_repl_open", async (ctx) => {
    await showReplacementShiftPicker(ctx);
});

staffHandlers.callbackQuery(/^staff_repl_pick_(.+)$/, async (ctx) => {
    await showReplacementConfirmation(ctx, ctx.match![1]!);
});

staffHandlers.callbackQuery(/^staff_repl_start_(.+)$/, async (ctx) => {
    const shiftId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return ctx.answerCallbackQuery("Користувача не знайдено");

    try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
        await replacementService.startRequest(ctx.api, user.staffProfile.id, shiftId);

        const activeRequest = await (await import("../../../db/core.js")).default.replacementRequest.findFirst({
            where: { workShiftId: shiftId, requesterStaffId: user.staffProfile.id, status: "ACTIVE" },
            include: { location: true },
            orderBy: { createdAt: "desc" }
        });
        const locations = activeRequest
            ? await (await import("../../../repositories/location-repository.js")).locationRepository.findByCity(activeRequest.location.city)
            : [];
        const text = locations.length > 1
            ? "Пошук розпочато.\nСпочатку запитаємо фотографів цієї локації."
            : "Пошук розпочато.\nЗапитаємо фотографів, які можуть вийти цього дня.";

        const kb = new InlineKeyboard();
        if (activeRequest) kb.text("Скасувати пошук", `staff_repl_cancel_${activeRequest.id}`).danger().row();
        kb.text("🏠 Меню", "staff_hub_nav");

        await ScreenManager.renderScreen(ctx, text, kb, { forceNew: true });
        await ctx.answerCallbackQuery("Пошук запущено");
    } catch (error: any) {
        let message = "Не вдалося запустити пошук.";
        if (error?.message === "REQUEST_ALREADY_ACTIVE") {
            message = "Пошук для цієї зміни вже активний.";
        } else if (error?.message === "REQUEST_ALREADY_FOUND") {
            message = "Підміну для цієї зміни вже знайдено. Якщо графік ще не оновили, напиши в підтримку.";
        } else if (error?.message === "REQUEST_PREVIOUSLY_FAILED") {
            message = "Ти вже запускала пошук для цієї зміни, але заміну не знайшли. Напиши в підтримку, щоб команда допомогла вручну.";
        } else if (error?.message === "SHIFT_ALREADY_STARTED") {
            message = "Ця зміна вже почалась.";
        }
        await ctx.answerCallbackQuery({ text: message, show_alert: true });
    }
});

staffHandlers.callbackQuery(/^staff_repl_cancel_(.+)$/, async (ctx) => {
    const requestId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return ctx.answerCallbackQuery("Користувача не знайдено");

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    const cancelled = await replacementService.cancelRequest(ctx.api, user.staffProfile.id, requestId);
    await ScreenManager.renderScreen(
        ctx,
        cancelled ? "Пошук скасовано." : "Цей пошук вже неактивний.",
        new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"),
        { forceNew: true }
    );
    await ctx.answerCallbackQuery(cancelled ? "Скасовано" : "Вже неактивно");
});

staffHandlers.callbackQuery(/^staff_repl_accept_(.+)$/, async (ctx) => {
    const requestId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return ctx.answerCallbackQuery("Користувача не знайдено");

    try {
        const result = await replacementService.accept(ctx.api, user.staffProfile.id, requestId);
        const messageByResult: Record<typeof result, string> = {
            accepted: "Дякуємо, підміну прийнято.",
            already_answered: "Відповідь уже збережено.",
            closed: "Запит уже закрито.",
            conflict: "У тебе вже є зміна цього дня.",
            not_found: "Запит не знайдено."
        };
        await ctx.answerCallbackQuery({
            text: messageByResult[result],
            show_alert: result === "closed" || result === "conflict" || result === "not_found"
        });
    } catch (err) {
        logger.error({
            err,
            event: "staff.replacement.accept_failed",
            request_id: requestId,
            staff_id: user.staffProfile.id,
            result: "failure"
        }, "Replacement acceptance failed");
        await ctx.answerCallbackQuery({
            text: "Не вдалося зберегти відповідь. Спробуйте ще раз.",
            show_alert: true
        }).catch(() => { });
    }
});

staffHandlers.callbackQuery(/^staff_repl_decline_(.+)$/, async (ctx) => {
    const requestId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) return ctx.answerCallbackQuery("Користувача не знайдено");

    try {
        const result = await replacementService.decline(ctx.api, user.staffProfile.id, requestId);
        const messageByResult: Record<typeof result, string> = {
            declined: "Дякуємо за відповідь.",
            already_answered: "Відповідь уже збережено.",
            closed: "Запит уже закрито.",
            not_found: "Запит не знайдено."
        };
        await ctx.answerCallbackQuery({
            text: messageByResult[result],
            show_alert: result === "closed" || result === "not_found"
        });
    } catch (err) {
        logger.error({
            err,
            event: "staff.replacement.decline_failed",
            request_id: requestId,
            staff_id: user.staffProfile.id,
            result: "failure"
        }, "Replacement decline failed");
        await ctx.answerCallbackQuery({
            text: "Не вдалося зберегти відповідь. Спробуйте ще раз.",
            show_alert: true
        }).catch(() => { });
    }
});

staffHandlers.callbackQuery(/^staff_task_proof_start_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) {
        return ctx.answerCallbackQuery("Користувача не знайдено");
    }

    const task = await taskService.getTaskById(taskId);
    if (!task || task.staffId !== user.staffProfile.id) {
        return ctx.answerCallbackQuery("Завдання не знайдено");
    }

    try {
        const draft = await taskProofService.startDraft(taskId, user.staffProfile.id);
        ctx.session.step = `awaiting_task_proof_${taskId}`;
        ctx.session.taskProofFlow = { taskId };
        await renderTaskProofScreen(ctx, taskId, task.taskText, draft.items.length, true);
        await ctx.answerCallbackQuery();
    } catch (error: any) {
        const message = error?.message === "Another proof draft is already in progress"
            ? "Заверши або скасуй поточне підтвердження"
            : "Не вдалося відкрити підтвердження";
        await ctx.answerCallbackQuery(message);
    }
});

staffHandlers.callbackQuery(/^staff_task_proof_submit_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) {
        return ctx.answerCallbackQuery("Користувача не знайдено");
    }

    try {
        const submission = await taskProofService.submitDraft(taskId, user.staffProfile.id);
        ctx.session.step = "idle";
        delete ctx.session.taskProofFlow;
        await notifySupportAboutTaskProof(ctx, submission);
        await showStaffTasks(ctx, true);
        await ctx.answerCallbackQuery("Підтвердження надіслано");
    } catch (error: any) {
        const message = error?.message === "Draft is empty"
            ? "Спочатку надішли підтвердження"
            : "Не вдалося завершити завдання";
        await ctx.answerCallbackQuery(message);
    }
});

staffHandlers.callbackQuery(/^staff_task_proof_cancel_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery();

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user?.staffProfile) {
        return ctx.answerCallbackQuery("Користувача не знайдено");
    }

    await taskProofService.cancelDraft(taskId, user.staffProfile.id).catch(() => false);
    ctx.session.step = "idle";
    delete ctx.session.taskProofFlow;
    await showStaffTasks(ctx, true);
    await ctx.answerCallbackQuery("Надсилання скасовано");
});

staffHandlers.callbackQuery(/^staff_task_proof_reply_(.+)$/, async (ctx) => {
    const submissionId = ctx.match![1]!;
    const telegramId = ctx.from?.id;
    if (!telegramId) return ctx.answerCallbackQuery("Користувача не знайдено");

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    const submission = await taskProofService.getSubmissionById(submissionId);
    if (!user?.staffProfile || !submission || submission.staffId !== user.staffProfile.id || submission.supportTopicStatus === "CLOSED") {
        return ctx.answerCallbackQuery("Це уточнення вже недоступне");
    }

    ctx.session.step = `awaiting_task_proof_topic_reply_${submissionId}`;
    ctx.session.taskProofFlow = {
        ...(ctx.session.taskProofFlow || {}),
        taskId: submission.taskId,
        replySubmissionId: submissionId,
    };
    await ctx.answerCallbackQuery("Можна відповідати");
    await ScreenManager.renderScreen(
        ctx,
        `💬 <b>Напиши відповідь для команди support</b>\n\nМожна надіслати текст, фото, відео, файл або кілька повідомлень підряд. Я передам їх у правильний topic.`,
        new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"),
        { forceNew: true }
    );
});

staffHandlers.callbackQuery(/^staff_task_toggle_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    await taskService.toggleTaskStatus(taskId);
    await showStaffTasks(ctx);
    await ctx.answerCallbackQuery("Статус змінено! ✨").catch(() => { });
});

staffHandlers.callbackQuery(/^staff_task_help_(.+)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const task = await taskService.getTaskById(taskId);
    if (!task) return ctx.answerCallbackQuery("Завдання не знайдено.");

    ctx.session.step = "create_ticket";
    ctx.session.clarificationTaskId = taskId;

    const taskPreview = truncateText(htmlToPlainText(task.taskText), 100);
    const text =
        `❓ <b>Уточнення по завданню:</b>\n\n` +
        `<i>"${escapeHtml(taskPreview)}"</i>\n\n` +
        `Напиши, що саме незрозуміло, і я передам твої слова адміну. ✍️`;

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard().text("✖️ Скасувати", "staff_hub_nav").danger(), {
        pushToStack: true
    });
    await ctx.answerCallbackQuery();
});
