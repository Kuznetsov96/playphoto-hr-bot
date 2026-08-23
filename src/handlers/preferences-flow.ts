import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { userRepository } from "../repositories/user-repository.js";
import { preferencesService } from "../services/preferences-service.js";
import type { PreferenceData } from "../services/preferences-service.js";
import { pendingReplyRepository } from "../repositories/pending-reply-repository.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";
import { awsBusinessClient } from "../services/aws-business-client.js";
import { redis } from "../core/redis.js";
import { formatSurnameNameDot } from "../utils/string-utils.js";
import { escapeHtml } from "./admin/utils.js";
import { AWS_PREFERENCES_CANONICAL_WRITE_ENABLED } from "../config.js";
import {
    readCanonicalPreferenceDays,
    saveCanonicalPreference,
    type CanonicalPreferenceReasonCode,
} from "../services/canonical-preferences-writer.js";
import { formatWorksUntil, lastSelectableDay } from "../utils/last-working-day.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { toCanonicalMonth, UKRAINIAN_MONTH_INDEX } from "../services/preference-month.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";


export const preferencesHandlers = new Composer<MyContext>();

function getKyivNow() {
    const now = new Date();
    return new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
}

function getMonthName(date: Date) {
    return date.toLocaleString('uk-UA', { month: 'long' });
}

function isFirstShiftCandidate(user: any) {
    return user?.candidate?.currentStep === "FIRST_SHIFT" && user?.candidate?.status === "AWAITING_FIRST_SHIFT";
}

function getPreferenceTableName(user: any, fallback = "Фотограф") {
    const profile = user?.staffProfile;
    if (profile?.surnameNameDot) return profile.surnameNameDot;

    const fullName = profile?.fullName || user?.candidate?.fullName || fallback;
    return formatSurnameNameDot(fullName) || fullName || fallback;
}

/**
 * The month a reminder broadcast is asking active staff about: after the 23rd
 * it is next month (mirrors startPreferencesFlow's monthOffset for active
 * staff), otherwise the current month. Used when a photographer opts out via
 * the broadcast button directly, without ever opening the calendar flow —
 * `ctx.session.preferencesData` is empty in that case, so there is no month to
 * read from session.
 */
function getActiveStaffTargetMonthDate(kyivNow: Date) {
    const isLateInMonth = kyivNow.getDate() >= 23;
    const monthOffset = isLateInMonth ? 1 : 0;
    return new Date(kyivNow.getFullYear(), kyivNow.getMonth() + monthOffset, 1);
}

async function ensureActiveStaffTargetsNextMonth(ctx: MyContext) {
    if (!ctx.session.preferencesData || !ctx.from?.id) return false;

    const user = await userRepository.findWithProfilesByTelegramId(BigInt(ctx.from.id));
    if (!user?.staffProfile?.isActive) return false;

    const kyivNow = getKyivNow();
    if (kyivNow.getDate() < 23) return false;

    const currentMonthName = getMonthName(kyivNow).toLowerCase();
    const selectedMonth = ctx.session.preferencesData.month?.toLowerCase();
    if (selectedMonth !== currentMonthName) return false;

    const nextMonthDate = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
    ctx.session.preferencesData = {
        month: getMonthName(nextMonthDate),
        year: nextMonthDate.getFullYear(),
        selectedDays: [],
        comment: "",
        step: 'CALENDAR',
        forceNextMonth: false
    };

    return true;
}

preferencesHandlers.callbackQuery("staff_start_prefs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startPreferencesFlow(ctx);
});

preferencesHandlers.callbackQuery("pref_fill", async (ctx) => {
    await ctx.answerCallbackQuery();
    await startPreferencesFlow(ctx);
});

preferencesHandlers.callbackQuery("pref_force_edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.preferencesData = { step: 'CALENDAR', forceEdit: true };
    await startPreferencesFlow(ctx);
});

/**
 * Кнопки, которая сюда ведёт, больше нет — `buildBroadcastKeyboard` её не рисует
 * (см. комментарий там о том, почему). Обработчик остаётся НАМЕРЕННО: рассылки,
 * ушедшие до этого изменения, лежат в чатах у людей вместе со своей клавиатурой,
 * и Telegram отдаст этот callback, когда по ней нажмут. Удалить обработчик —
 * значит превратить старую кнопку в тихий отказ у человека, который просто хотел
 * выключить напоминания.
 *
 * Удалять можно, когда пройдёт месяц сбора и старые сообщения перестанут быть
 * актуальными.
 */
preferencesHandlers.callbackQuery("pref_opt_out", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.answerCallbackQuery();

    // Mark all pending preference replies as declined → stops pinger
    await pendingReplyRepository.updateMany(
        { userId: BigInt(userId), status: "pending" },
        { status: "declined", respondedAt: new Date() }
    );

    try {
        const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));

        if (AWS_PREFERENCES_CANONICAL_WRITE_ENABLED) {
            const sessionData = ctx.session.preferencesData;
            const targetDate = getActiveStaffTargetMonthDate(getKyivNow());
            const month = sessionData?.month ?? getMonthName(targetDate);
            const year = sessionData?.year ?? targetDate.getFullYear();
            const canonicalMonth = toCanonicalMonth(month, year);
            const staffId = user?.staffProfile?.id;
            if (!canonicalMonth || !staffId) {
                logger.error({ userId, month, year }, "Preference month could not be converted to YYYY-MM");
                await ctx.answerCallbackQuery();
                await ctx.reply(CANDIDATE_TEXTS["preferences-save-failed"]);
                return;
            }
            const saved = await saveCanonicalPreference({
                staffId,
                month: canonicalMonth,
                selectedDays: [],
                comment: null,
                telegramId: String(userId),
                declined: true
            });
            if (!saved.ok) {
                await ctx.answerCallbackQuery();
                await ctx.reply(preferenceSaveFailureText(saved.reasonCode, month));
                return;
            }
        } else {
            // Log opt-out to Google Sheets so admin sees who refused
            const fullName = getPreferenceTableName(user, "Невідомий");
            const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

            await preferencesService.savePreference({
                timestamp,
                fullNameDot: fullName,
                unworkableDays: "🚫 Відмовилась заповнювати",
                comment: ""
            });
        }
    } catch (e) {
        logger.error({ err: e, userId }, "Failed to log pref opt-out");
    }

    await ctx.answerCallbackQuery("🚫 Нагадування вимкнено.");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
});

async function readWorksUntil(
    employeePublicId: string | null,
    month: string | null,
    telegramId: string,
): Promise<string | null> {
    if (!employeePublicId || !month) return null;
    try {
        const read = await awsBusinessClient.getSchedulePreference(employeePublicId, month, telegramId);
        return read.worksUntil ?? null;
    } catch (error) {
        logger.warn({ err: error, employeePublicId, month }, "Failed to read worksUntil for the preferences calendar");
        return null;
    }
}

export async function startPreferencesFlow(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));
    const isActiveStaff = user?.staffProfile?.isActive === true;
    const isNewCandidate = !isActiveStaff && isFirstShiftCandidate(user);
    const isEligible = isActiveStaff || isNewCandidate;

    if (!isEligible) {
        return ctx.reply("❌ Ця функція поки що недоступна.");
    }

    const kyivNow = getKyivNow();
    const isLateInMonth = kyivNow.getDate() >= 23;

    // Active staff after 23rd → jump straight to next month
    // New candidates after 23rd → start with current month, then chain to next
    const monthOffset = (!isNewCandidate && isLateInMonth) ? 1 : 0;
    const targetMonthDate = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + monthOffset, 1);

    const fullName = user?.staffProfile?.fullName || user?.candidate?.fullName || "";

    // Check if photographer already filled preferences — offer to update.
    // Legacy-only: the canonical PUT is idempotent per month, so this
    // pre-check is unnecessary (and would need a canonical read) once the
    // flag is on.
    if (!AWS_PREFERENCES_CANONICAL_WRITE_ENABLED && !isNewCandidate && fullName) {
        const alreadyFilled = await preferencesService.hasExistingPreference(fullName);
        if (alreadyFilled && !ctx.session.preferencesData?.forceEdit) {
            const kb = new InlineKeyboard()
                .text("✏️ Змінити побажання", "pref_force_edit")
                .text("⬅️ Назад", "staff_hub_nav");
            await ScreenManager.renderScreen(ctx,
                `✅ <b>Ти вже заповнила побажання на цей місяць!</b>\n\nЯкщо хочеш змінити — натисни кнопку нижче.`,
                kb, { forceNew: true });
            return;
        }
    }
    delete ctx.session.preferencesData?.forceEdit;

    const monthName = getMonthName(targetMonthDate);
    const targetYear = targetMonthDate.getFullYear();
    const canonicalMonth = toCanonicalMonth(monthName, targetYear);

    // Останній робочий день тих, хто доопрацьовує, щоб клавіатура не
    // пропонувала дні, коли людини вже не буде. Збій читання не має ламати
    // весь флоу: без дати календар просто лишається повним, як раніше.
    const worksUntil = await readWorksUntil(
        user?.staffProfile?.awsEmployeePublicId ?? null,
        canonicalMonth,
        String(telegramId),
    );

    // Уже отмеченные дни подставляются в календарь при повторном заходе.
    //
    // Раньше человек, зашедший второй раз, попадал в ПУСТОЙ календарь и не
    // видел, что именно подал: приходилось либо заполнять заново по памяти,
    // либо не трогать вовсе, не зная текущего состояния. Проверка «ты уже
    // заполнила» существовала только в legacy-ветке, а с каноническим
    // флагом — который включён — не работала вовсе.
    //
    // `undefined` (не замаплен, бэкенд недоступен, отказ) оставляет пустой
    // календарь: показать «ты ничего не отмечала» при сбое сети значило бы
    // соврать, а промолчать — всего лишь вернуть прежнее поведение.
    let prefilledDays: number[] = [];
    const staffId = user?.staffProfile?.id;
    if (AWS_PREFERENCES_CANONICAL_WRITE_ENABLED && staffId && !isNewCandidate && canonicalMonth) {
        const existing = await readCanonicalPreferenceDays({
            staffId,
            month: canonicalMonth,
            telegramId: String(telegramId),
        });
        if (existing) prefilledDays = existing;
    }

    ctx.session.preferencesData = {
        month: monthName,
        worksUntil,
        year: targetYear,
        selectedDays: prefilledDays,
        comment: "",
        step: 'CALENDAR',
        forceNextMonth: isNewCandidate && isLateInMonth,
        prefilled: prefilledDays.length > 0
    };

    await renderCalendar(ctx);
}

async function renderCalendar(ctx: MyContext) {
    if (!ctx.session.preferencesData) return;
    await ensureActiveStaffTargetsNextMonth(ctx);
    const { month, selectedDays, year } = ctx.session.preferencesData;

    const kyivNow = getKyivNow();

    const targetMonthIndex = UKRAINIAN_MONTH_INDEX[month?.toLowerCase() || ''];
    const isCurrentMonth = targetMonthIndex === kyivNow.getMonth() && year === kyivNow.getFullYear();

    const daysInMonth = new Date(year || kyivNow.getFullYear(), (targetMonthIndex ?? 0) + 1, 0).getDate();

    // Той, хто доопрацьовує, не має бачити дні після свого останнього робочого:
    // позначати їх нема сенсу — на ці зміни його вже не поставлять.
    const lastDay = lastSelectableDay(
        ctx.session.preferencesData.worksUntil,
        year || kyivNow.getFullYear(),
        targetMonthIndex ?? 0,
        daysInMonth,
    );

    // Місяць цілком після останнього робочого дня: показувати 30 глухих
    // кнопок — це вигляд зламаного бота. Людина отримала запрошення
    // «познач свої вихідні» разом з усіма, тож мовчати теж не можна.
    if (lastDay === 0) {
        const kb = new InlineKeyboard().text("⬅️ Назад", "staff_hub_nav");
        const until = formatWorksUntil(ctx.session.preferencesData.worksUntil);
        await ScreenManager.renderScreen(
            ctx,
            `🗓 <b>Побажання (${month})</b>\n\n` +
                `Ти працюєш до <b>${until}</b>, тож побажання на ${month} не потрібні. ` +
                `Дякуємо за роботу! 💛`,
            kb,
            { pushToStack: true, manualMenuId: "staff-preferences" },
        );
        return;
    }

    const kb = new InlineKeyboard();
    const selected = new Set(selectedDays || []);

    // Standard calendar grid: 7 columns
    for (let d = 1; d <= daysInMonth; d++) {
        const isSelected = selected.has(d);
        const isTodayOrPast = isCurrentMonth && d <= kyivNow.getDate();
        const isAfterLastDay = d > lastDay;

        if (isTodayOrPast || isAfterLastDay) {
            // Block today, past days, and days after the last working one
            kb.text(`·`, `none`);
        } else {
            // Future days are selectable
            kb.text(isSelected ? `✅ ${d}` : `${d}`, `pref_toggle_${d}`);
        }

        // Row wrap every 7 days
        if (d % 7 === 0) kb.row();
    }

    // Navigation buttons
    kb.row();
    if (selected.size === 0) {
        kb.text("✨ Немає побажань (все вільно)", "pref_to_comment_none");
    } else {
        kb.text(`✅ Готово (${selected.size} дн.)`, "pref_to_comment");
    }
    kb.row().text("✖️ Скасувати", "pref_cancel_flow").danger();

    const selectionHint = isCurrentMonth
        ? `<i>(Вибір вихідних доступний з завтрашнього дня)</i>`
        : `<i>(Натисни на дати нижче)</i>`;

    // Скорочений календар без пояснення виглядає як помилка бота.
    const worksUntilHint = lastDay < daysInMonth
        ? `Твій останній робочий день — <b>${lastDay} ${month}</b>, тож познач дні лише до нього.\n\n`
        : "";

    // Отмеченные дни при повторном заходе нужно объяснить: без строки они
    // выглядят как чужой выбор или сбой, и человек не понимает, менять их
    // или начинать сначала.
    const alreadySubmitted = ctx.session.preferencesData.step === 'CALENDAR'
        && (selectedDays?.length ?? 0) > 0
        && ctx.session.preferencesData.prefilled === true;

    const text = `🗓 <b>Побажання (${month})</b>\n\n` +
        (alreadySubmitted
            ? `Ти вже надсилала побажання на цей місяць — вони позначені нижче. Зміни, якщо треба, і натисни «Готово». ✅\n\n`
            : "") +
        `Познач дні, коли ти <b>НЕ МОЖЕШ</b> вийти на зміну (твої вихідні). 🚫\n\n` +
        worksUntilHint +
        selectionHint;

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
}

preferencesHandlers.callbackQuery(/^pref_toggle_(\d+)$/, async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery("Сесія застаріла.");
    const day = parseInt(ctx.match![1]!);

    // Кнопка на екрані вже заглушена, але старе повідомлення в чаті могло
    // зберегти день після останнього робочого — не приймаємо його.
    const { month: pMonth, year: pYear, worksUntil } = ctx.session.preferencesData;
    const pMonthIndex = UKRAINIAN_MONTH_INDEX[pMonth?.toLowerCase() || ''] ?? 0;
    const pYearValue = pYear || getKyivNow().getFullYear();
    const pDaysInMonth = new Date(pYearValue, pMonthIndex + 1, 0).getDate();
    if (day > lastSelectableDay(worksUntil, pYearValue, pMonthIndex, pDaysInMonth)) {
        return ctx.answerCallbackQuery("Цей день уже після твого останнього робочого.");
    }

    const selected = new Set(ctx.session.preferencesData.selectedDays);
    if (selected.has(day)) selected.delete(day);
    else selected.add(day);
    ctx.session.preferencesData.selectedDays = Array.from(selected);
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery(["pref_to_comment", "pref_to_comment_none"], async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery("Сесія застаріла.");
    if (await ensureActiveStaffTargetsNextMonth(ctx)) {
        await renderCalendar(ctx);
        return ctx.answerCallbackQuery("Оновлено на наступний місяць.");
    }
    if (ctx.callbackQuery?.data === "pref_to_comment_none") ctx.session.preferencesData.selectedDays = [];
    ctx.session.preferencesData.step = 'COMMENT';

    const daysStr = ctx.session.preferencesData.selectedDays!.length > 0
        ? ctx.session.preferencesData.selectedDays!.sort((a, b) => a - b).join(", ")
        : "Немає (працюю у будь-який день)";

    const text = `🗓 <b>Вибрані вихідні:</b> ${daysStr}\n\nНапиши коментар або додаткові побажання.\n\n👇 <b>Надішли повідомлення</b> або натисни кнопку:`;
    const kb = new InlineKeyboard().text("⬅️ Назад", "pref_back_calendar").row().text("⏩ Без коментаря", "pref_skip_comment");

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("pref_back_calendar", async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery();
    ctx.session.preferencesData.step = 'CALENDAR';
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("pref_skip_comment", async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery();
    if (await ensureActiveStaffTargetsNextMonth(ctx)) {
        await renderCalendar(ctx);
        return ctx.answerCallbackQuery("Оновлено на наступний місяць.");
    }
    ctx.session.preferencesData.comment = "";
    ctx.session.preferencesData.step = 'CONFIRM';
    await renderConfirmation(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("pref_cancel_flow", async (ctx) => {
    await ctx.answerCallbackQuery("❌ Скасовано.");
    delete ctx.session.preferencesData;
    ctx.session.step = "idle";

    // Instead of importing showStaffHub, we just show the hub menu
    // User can click /start or we can show a "Back to Menu" button
    await ScreenManager.renderScreen(ctx, "Дію скасовано. Ти можеш повернутися до головного меню: 👇", "staff-main", { forceNew: true });
});

async function renderConfirmation(ctx: MyContext) {
    if (!ctx.session.preferencesData) return;
    const { month, year, selectedDays, comment } = ctx.session.preferencesData;
    const user = await userRepository.findWithProfilesByTelegramId(BigInt(ctx.from!.id));
    const name = user?.staffProfile?.fullName || user?.candidate?.fullName || "Фотограф";
    const daysStr = selectedDays && selectedDays.length > 0 ? selectedDays.sort((a, b) => a - b).join(", ") : "Немає";

    const summary = `📝 <b>Підтвердження:</b>\n\n👤 Ім'я: <b>${escapeHtml(name)}</b>\n📅 Місяць: <b>${escapeHtml(month || "—")} ${year}</b>\n🚫 Вихідні: <b>${escapeHtml(daysStr)}</b>\n💬 Коментар: ${escapeHtml(comment || 'відсутній')}`;
    // «🔄 Спочатку» и «✖️ Скасувати» стояли рядом, и разница между ними была
    // неочевидна: обе выглядели как «отменить». Теперь каждая называет, что
    // именно произойдёт, — HIG требует называть последствие, а не намерение.
    // «Вийти без збереження» вдобавок предупреждает, что работа пропадёт.
    const kb = new InlineKeyboard()
        .text("✅ Зберегти", "pref_save_final")
        .row()
        .text("✏️ Змінити дні", "pref_back_calendar")
        .row()
        .text("✖️ Вийти без збереження", "pref_cancel_flow").danger();

    await ScreenManager.renderScreen(ctx, summary, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
}

/**
 * Кнопка «🔄 Спочатку» убрана с экрана подтверждения: рядом со «Скасувати» она
 * читалась как второй способ отменить, хотя сбрасывала выбор и возвращала в
 * календарь. Её место занял «✏️ Змінити дні», который НЕ теряет отмеченное.
 *
 * Обработчик остаётся: экраны подтверждения, отрисованные до деплоя, всё ещё
 * висят у людей в чатах со старой клавиатурой.
 */
preferencesHandlers.callbackQuery("pref_restart_flow", async (ctx) => {
    if (!ctx.session.preferencesData) return;
    ctx.session.preferencesData.selectedDays = [];
    ctx.session.preferencesData.comment = "";
    ctx.session.preferencesData.step = 'CALENDAR';
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("open_support_dialog", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { startSupportFlow } = await import("../modules/staff/handlers/menu.js");
    await startSupportFlow(ctx);
});

preferencesHandlers.callbackQuery("pref_save_final", async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery("Помилка.");
    if (await ensureActiveStaffTargetsNextMonth(ctx)) {
        await renderCalendar(ctx);
        return ctx.answerCallbackQuery("Оновлено на наступний місяць.");
    }
    const { selectedDays, comment, month } = ctx.session.preferencesData;
    const telegramId = ctx.from?.id;
    await ctx.answerCallbackQuery();

    const waitMsg = await ctx.reply("⏳ Зберігаю...");
    try {
        const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId!));
        const staffNameForTable = getPreferenceTableName(user);
        const daysStr = selectedDays && selectedDays.length > 0 ? selectedDays.sort((a, b) => a - b).join(", ") : "Немає побажань";
        const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
        const wasNewCandidate = !user?.staffProfile?.isActive && isFirstShiftCandidate(user);
        let createdStaffProfile = false;

        const kyivNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const currentMonthName = kyivNow.toLocaleString('uk-UA', { month: 'long' });
        const isCurrentMonth = (month || "").toLowerCase() === currentMonthName.toLowerCase();
        const shouldMoveToNext = !!ctx.session.preferencesData.forceNextMonth && isCurrentMonth;
        const shouldPersist = !wasNewCandidate || !shouldMoveToNext;

        if (shouldPersist) {
            // A brand-new candidate has no StaffProfile yet; both the sheet
            // write and the canonical write (which resolves staffId →
            // awsEmployeePublicId) need one to attribute the submission to.
            let staffProfileId = user?.staffProfile?.id;
            if (wasNewCandidate && !staffProfileId && user?.candidate) {
                const { staffRepository } = await import("../repositories/staff-repository.js");
                const createData: any = {
                    user: { connect: { id: user.id } },
                    fullName: user.candidate.fullName || "Фотограф",
                    isActive: true
                };
                if (user.candidate.locationId) createData.location = { connect: { id: user.candidate.locationId } };
                const newProfile = await staffRepository.create(createData);
                staffProfileId = newProfile.id;
                createdStaffProfile = true;
            }

            if (AWS_PREFERENCES_CANONICAL_WRITE_ENABLED) {
                const canonicalMonth = toCanonicalMonth(month, ctx.session.preferencesData.year);
                if (!canonicalMonth || !staffProfileId) {
                    logger.error({ telegramId, month, year: ctx.session.preferencesData.year }, "Preference month could not be converted to YYYY-MM");
                    await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => { });
                    await ctx.reply(CANDIDATE_TEXTS["preferences-save-failed"]);
                    return;
                }
                const saved = await saveCanonicalPreference({
                    staffId: staffProfileId,
                    month: canonicalMonth,
                    selectedDays: selectedDays ?? [],
                    comment: comment || null,
                    telegramId: String(telegramId),
                    declined: false
                });
                if (!saved.ok) {
                    await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => { });
                    await ctx.reply(preferenceSaveFailureText(saved.reasonCode, month ?? "наступний місяць"));
                    return;
                }
            } else {
                const prefData: PreferenceData = {
                    timestamp,
                    fullNameDot: staffNameForTable,
                    unworkableDays: daysStr,
                    comment: comment || ""
                };

                try {
                    const { preferencesQueue } = await import("../core/queue.js");
                    await preferencesQueue.add('save-pref', prefData, { attempts: 5, backoff: { type: 'exponential', delay: 10000 } });
                } catch {
                    await preferencesService.savePreference(prefData);
                }
            }
        } else {
            logger.info({ telegramId, month }, "Skipping preference write for candidate current-month preferences; admin notification only");
        }

        // Mark pending reply as confirmed → stops pinger reminders
        await pendingReplyRepository.updateMany(
            { userId: BigInt(telegramId!), status: "pending" },
            { status: "confirmed", respondedAt: new Date() }
        );

        // Mark this user as having filled preferences for this month → broadcast will skip them
        const prefFilledKey = `pref_filled:${telegramId}:${month}`;
        await redis.set(prefFilledKey, "1", "EX", 40 * 24 * 60 * 60); // 40 days TTL

        await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => { });

        if (shouldMoveToNext) {
            const nextMonthDate = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
            const nextMonthName = nextMonthDate.toLocaleString('uk-UA', { month: 'long' });

            ctx.session.preferencesData = {
                month: nextMonthName,
                year: nextMonthDate.getFullYear(),
                selectedDays: [],
                comment: "",
                step: 'CALENDAR',
                forceNextMonth: false
            };

            await ScreenManager.renderScreen(ctx, `✅ <b>Вихідні на ${month} збережені.</b>\n\nТепер давай заповнимо на <b>${nextMonthName}</b>, щоб ми могли скласти повний графік! ✨`, undefined, { forceNew: true });
            await renderCalendar(ctx);
        } else {
            delete ctx.session.preferencesData;
            ctx.session.step = "idle";

            if (wasNewCandidate && user?.candidate) {
                const hireUser = user;
                const candidate = hireUser.candidate!;
                // Auto-hire: create StaffProfile + flip role, but DON'T send "schedule ready" yet.
                // The real welcome ("Графік готовий!") comes later when admin syncs shifts.
                try {
                    const { staffRepository } = await import("../repositories/staff-repository.js");
                    const { candidateRepository } = await import("../repositories/candidate-repository.js");
                    const { accessService } = await import("../services/access-service.js");

                    // Create StaffProfile (isWelcomeSent defaults to false)
                    if (!hireUser.staffProfile && !createdStaffProfile) {
                        const createData: any = {
                            user: { connect: { id: hireUser.id } },
                            fullName: candidate.fullName || "Фотограф",
                            isActive: true
                        };
                        if (candidate.locationId) createData.location = { connect: { id: candidate.locationId } };
                        await staffRepository.create(createData);
                    }

                    // Update candidate status to HIRED + flip role to STAFF
                    await candidateRepository.update(candidate.id, { status: 'HIRED' as any });
                    await userRepository.update(hireUser.id, { role: 'STAFF' as any });

                    // Sync channel access
                    await accessService.syncUserAccess(hireUser.telegramId, "Auto-hire after onboarding").catch(() => { });

                    logger.debug({ userId: hireUser.id }, "Auto-hire completed; waiting for schedule sync");
                } catch (hireErr) {
                    logger.error({ err: hireErr, userId: hireUser.id }, "Auto-hire failed; candidate remains awaiting first shift");
                }

                // Always show "schedule is being prepared" screen
                const KNOWLEDGE_BASE_LINK = "https://t.me/+hC9UDoSZb3hiZjFi";
                const welcomeText = `💫 <b>Вітаємо в команді PlayPhoto!</b>\n\n` +
                    `⏳ <b>Твій графік готується</b>\n\n` +
                    `Ми вже створюємо для тебе перші робочі зміни! ✨\n` +
                    `Як тільки графік буде готовий, ти отримаєш сповіщення тут.\n\n` +
                    `📖 Поки що можеш ознайомитися з нашою <a href="${KNOWLEDGE_BASE_LINK}">Базою знань</a>, щоб підготуватися до першого дня.`;
                const welcomeKb = new InlineKeyboard()
                    .url("📖 База знань", KNOWLEDGE_BASE_LINK).row()
                    .text("🚀 Відкрити Хаб", "staff_hub_nav");
                await ScreenManager.renderScreen(ctx, welcomeText, welcomeKb, { forceNew: true });
            } else {
                await ScreenManager.renderScreen(ctx, "✅ <b>Твої побажання успішно збережені!</b>", "staff-main", { forceNew: true });
            }
        }

        // Only notify admin for new candidates (auto-hire), not for regular staff filling monthly preferences
        if (wasNewCandidate) {
            const { ADMIN_IDS } = await import("../config.js");
            if (ADMIN_IDS.length > 0) {
                const adminNotifyText = `📅 <b>New Schedule Preferences!</b>\n\n` +
                    `👤 Staff: <b>${escapeHtml(staffNameForTable)}</b>\n` +
                    `📅 Month: <b>${escapeHtml(month || "—")}</b>\n` +
                    `🚫 Weekends: <b>${escapeHtml(daysStr)}</b>\n` +
                    `💬 Comment: ${escapeHtml(comment || 'none')}\n\n` +
                    (shouldMoveToNext ? `⏳ Waiting for the next month to be filled...` :
                        `✅ Auto-hired! Please add shifts to the schedule.`);

                await ctx.api.sendMessage(ADMIN_IDS[0]!, adminNotifyText, {
                    parse_mode: "HTML"
                });
            }
        }
    } catch (e: any) {
        logger.error({ err: e }, "Preferences save failed");
        await ScreenManager.renderError(ctx, "❌ Помилка при збереженні. Будь ласка, повідомте адміністратора.");
    }
});

export async function handlePreferenceComment(ctx: MyContext) {
    if (!ctx.session.preferencesData || ctx.session.preferencesData.step !== 'COMMENT') return false;
    const text = ctx.message?.text;
    if (!text) return false;
    ctx.session.preferencesData.comment = text;
    ctx.session.preferencesData.step = 'CONFIRM';
    await ctx.deleteMessage().catch(() => { });
    await renderConfirmation(ctx);
    return true;
}

/**
 * Что сказать человеку, когда пожелания не сохранились.
 *
 * Закрытое окно — не сбой: «Спробуй ще раз за хвилину» отправило бы
 * опоздавшего повторять то, что не сработает никогда. Ему нужно знать, что
 * дальше — через підміну.
 */
function preferenceSaveFailureText(
    reasonCode: CanonicalPreferenceReasonCode,
    monthName: string
): string {
    return reasonCode === "SCHEDULE_PREFERENCES_CLOSED"
        ? STAFF_TEXTS["staff-preferences-window-closed"]({ monthName })
        : CANDIDATE_TEXTS["preferences-save-failed"];
}
