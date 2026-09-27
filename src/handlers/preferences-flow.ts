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
import { ActionDedupeWindow } from "../utils/action-dedupe.js";


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

/** Предел `comment` в API вебаппа (`@MaxLength(500)` в DTO пожеланий). */
const COMMENT_MAX_LENGTH = 500;

/**
 * Сколько шаг 'COMMENT' ждёт сообщения. Дольше — значит, человек ушёл, и его
 * следующее сообщение адресовано не форме (чаще всего — в підтримку).
 */
const COMMENT_CAPTURE_MS = 30 * 60 * 1000;

function supportKeyboard() {
    return new InlineKeyboard().text(STAFF_TEXTS["staff-preferences-btn-support"], "open_support_dialog");
}

/**
 * Кнопка формы нажата, а формы в сессии уже нет.
 *
 * Сессия живёт 24 часа с последнего действия и удаляется при сохранении или
 * выходе, а кнопки старых экранов остаются в чате навсегда. Раньше такое
 * нажатие отвечало «Сесія застаріла.», «Помилка.» или не отвечало вовсе —
 * человек оставался перед мёртвым экраном. Теперь форма открывается заново:
 * `startPreferencesFlow` сам подставит уже поданные дни и проверит, открыт ли
 * сбор.
 */
async function restartIfSessionLost(ctx: MyContext): Promise<boolean> {
    if (ctx.session.preferencesData) return false;
    await ctx.answerCallbackQuery(STAFF_TEXTS["staff-preferences-session-restarted"]);
    await startPreferencesFlow(ctx);
    return true;
}

/**
 * Открыт ли сбор на месяц. При сбое API — «открыт», как и кнопка в меню
 * (`shouldShowPreferencesButton`): бэкенд всё равно откажет при записи, если
 * окно закрыто, а ложное «закрито» отняло бы форму у того, кто успевал.
 */
async function isCollectionOpen(canonicalMonth: string): Promise<boolean> {
    try {
        const window = await awsBusinessClient.schedulePreferenceWindow(canonicalMonth);
        return window.open;
    } catch (error) {
        logger.warn({ err: error, month: canonicalMonth }, "Preference collection window unavailable; opening the form");
        return true;
    }
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
                await ctx.reply(STAFF_TEXTS["staff-preferences-save-failed"]);
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

    // Сбор закрыт — говорим сразу, а не после заполнения. Кнопка в меню в этот
    // момент уже скрыта, но «Заповнити графік» в приглашении и «Заповнити зараз»
    // в напоминании лежат в чате и ведут сюда: человек отмечал бы дни, чтобы на
    // «Зберегти» узнать, что всё зря. Кандидатов первой смены это не касается —
    // их пожелания идут не через окно сбора.
    if (isActiveStaff && AWS_PREFERENCES_CANONICAL_WRITE_ENABLED && canonicalMonth && !(await isCollectionOpen(canonicalMonth))) {
        delete ctx.session.preferencesData;
        const kb = supportKeyboard().row().text("⬅️ Назад", "staff_hub_nav");
        await ScreenManager.renderScreen(ctx, STAFF_TEXTS["staff-preferences-window-closed"]({ monthName }), kb, { forceNew: true });
        return;
    }

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
            kb.text(`·`, `pref_noop`);
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

/**
 * Недоступная клетка календаря («·»: прошедший день или после последнего
 * рабочего).
 *
 * Раньше у неё был callback `none` без обработчика. Его ловил щит устаревших
 * кнопок (`handlers/index.ts`): «⚠️ This button is outdated», удаление
 * календаря и выброс в главное меню — по промаху пальцем мимо числа. `none`
 * отвечается тихо: такие календари ещё лежат в чатах, и та же заглушка стоит
 * в списке тикетов у админов.
 */
preferencesHandlers.callbackQuery("pref_noop", (ctx) =>
    ctx.answerCallbackQuery(STAFF_TEXTS["staff-preferences-day-unavailable"]),
);
preferencesHandlers.callbackQuery("none", (ctx) => ctx.answerCallbackQuery());

preferencesHandlers.callbackQuery(/^pref_toggle_(\d+)$/, async (ctx) => {
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
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
    // Тот же довод для прошедших дней: календарь текущего месяца, открытый
    // вчера, ещё держит кнопку вчерашнего числа.
    const kyivToday = getKyivNow();
    if (pMonthIndex === kyivToday.getMonth() && pYearValue === kyivToday.getFullYear() && day <= kyivToday.getDate()) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["staff-preferences-day-unavailable"]);
    }

    const selected = new Set(ctx.session.preferencesData.selectedDays);
    if (selected.has(day)) selected.delete(day);
    else selected.add(day);
    ctx.session.preferencesData.selectedDays = Array.from(selected);
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery(["pref_to_comment", "pref_to_comment_none"], async (ctx) => {
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
    if (await ensureActiveStaffTargetsNextMonth(ctx)) {
        await renderCalendar(ctx);
        return ctx.answerCallbackQuery("Оновлено на наступний місяць.");
    }
    if (ctx.callbackQuery?.data === "pref_to_comment_none") ctx.session.preferencesData.selectedDays = [];

    // Сразу подтверждение, без отдельного шага комментария.
    //
    // Шаг комментария стоял между «Готово» и «Зберегти» и выглядел как конец:
    // «Надішли повідомлення або натисни кнопку» и первой кнопкой «⬅️ Назад».
    // Люди выбирали дни, видели «Вибрані вихідні: …» и уходили, считая, что
    // всё отправлено, — а пожелания жили только в сессии и не доходили никуда.
    // Комментарий теперь — необязательная кнопка на экране подтверждения, где
    // главная кнопка — «Зберегти».
    ctx.session.preferencesData.step = 'CONFIRM';
    await renderConfirmation(ctx);
    await ctx.answerCallbackQuery();
});

/**
 * Комментарий — по явной кнопке, а не перехватом любого текста на экране
 * подтверждения.
 *
 * `preferencesData` живёт в сессии, пока человек не сохранит или не выйдет. Кто
 * бросил форму на подтверждении, через день пишет в підтримку — и перехват
 * съел бы это сообщение как комментарий, удалив его из чата. Шаг 'COMMENT'
 * включается только этим нажатием и выключается первым же сообщением.
 */
preferencesHandlers.callbackQuery("pref_add_comment", async (ctx) => {
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
    ctx.session.preferencesData.step = 'COMMENT';
    ctx.session.preferencesData.commentRequestedAt = Date.now();
    const text = `💬 Напиши коментар одним повідомленням (до ${COMMENT_MAX_LENGTH} символів) — наприклад, «хочу більше змін» або «можу на іншій локації».\n\nПотім повернешся до перевірки й збережеш.`;
    const kb = new InlineKeyboard().text("⬅️ Без коментаря", "pref_skip_comment");
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("pref_back_calendar", async (ctx) => {
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
    ctx.session.preferencesData.step = 'CALENDAR';
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery("pref_skip_comment", async (ctx) => {
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
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

    // Экран говорит прямо, что пожелания ещё НЕ отправлены: без этой строки
    // сводка «Вихідні: …» читается как квитанция, и человек уходит, не нажав.
    const summary = `📝 <b>Перевір і збережи</b>\n\n👤 Ім'я: <b>${escapeHtml(name)}</b>\n📅 Місяць: <b>${escapeHtml(month || "—")} ${year}</b>\n🚫 Вихідні: <b>${escapeHtml(daysStr)}</b>\n💬 Коментар: ${escapeHtml(comment || 'відсутній')}\n\nПобажання ще не надіслані — натисни «Зберегти».`;
    // «🔄 Спочатку» и «✖️ Скасувати» стояли рядом, и разница между ними была
    // неочевидна: обе выглядели как «отменить». Теперь каждая называет, что
    // именно произойдёт, — HIG требует называть последствие, а не намерение.
    // «Вийти без збереження» вдобавок предупреждает, что работа пропадёт.
    const kb = new InlineKeyboard()
        .text("✅ Зберегти", "pref_save_final")
        .row()
        .text(comment ? "💬 Змінити коментар" : "💬 Додати коментар", "pref_add_comment")
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
    if (await restartIfSessionLost(ctx)) return;
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

/**
 * Одно нажатие «Зберегти» — одна попытка записи.
 *
 * Запись версионирована на бэкенде, поэтому второе нажатие данные не испортит —
 * оно получит 409. Но человек увидит непонятную ошибку сразу после успешного
 * сохранения, что читается как «не сохранилось». Окно в 10 секунд закрывает
 * дребезг пальца и повторную доставку callback'а, но не мешает осознанному
 * повтору после неудачи.
 */
const saveDedupe = new ActionDedupeWindow(10_000);

/**
 * Когда у человека последний раз прошло сохранение (ms).
 *
 * Апдейты одного человека идут строго по очереди (`sequentialize` в
 * core/bot.ts), поэтому двойное нажатие «Зберегти» приходит ПОСЛЕ того, как
 * первое уже записало и удалило сессию. Без этой отметки второе нажатие
 * открывало бы форму заново поверх «успішно збережені».
 */
const lastSavedAt = new Map<number, number>();
const JUST_SAVED_MS = 60_000;

/**
 * Неудача сохранения возвращает человека на экран подтверждения с кнопками.
 *
 * Раньше здесь был `ctx.reply(...)` и `return`: экран подтверждения к этому
 * моменту уже заменён сообщением «⏳ Зберігаю...», и человек оставался с текстом
 * «спробуй ще раз» — но нажимать было не на что. Данные в сессии при этом целы,
 * то есть повторить было МОЖНО, просто нечем.
 */
async function failSave(
    ctx: MyContext,
    waitMessageId: number | undefined,
    text: string = STAFF_TEXTS["staff-preferences-save-failed"],
    canRetry: boolean = true,
): Promise<void> {
    // Снимаем защиту от дребезга: она существует, чтобы гасить второе нажатие
    // ПОКА идёт запись, а не чтобы блокировать осознанный повтор после отказа.
    const telegramId = ctx.from?.id;
    if (telegramId !== undefined) saveDedupe.release(`pref-save:${telegramId}`);

    if (waitMessageId !== undefined) {
        await ctx.api.deleteMessage(ctx.chat!.id, waitMessageId).catch(() => { });
    }
    // Без повтора человеку остаётся одно — підтримка, и кнопка ведёт туда сразу.
    // Экран подтверждения (уже без кнопок) убирается: его «натисни «Зберегти»»
    // рядом с «збір закрито» противоречило бы само себе.
    if (!canRetry) await ctx.deleteMessage().catch(() => { });
    await ctx.reply(text, canRetry ? {} : { reply_markup: supportKeyboard() });

    // Сессия не тронута — тот же выбор, та же клавиатура, кнопка «Зберегти»
    // снова доступна. Кроме случая, когда повторять нечего: закрытое окно
    // сбора не откроется от повторного нажатия, и кнопка обещала бы неправду.
    if (canRetry) await renderConfirmation(ctx);
}

preferencesHandlers.callbackQuery("pref_save_final", async (ctx) => {
    // Нет сессии: либо только что сохранили (двойное нажатие), либо форму
    // бросили больше суток назад. Первое — подтверждаем и ничего не делаем;
    // второе — открываем форму заново, поданные дни в ней будут отмечены.
    const tappedBy = ctx.from?.id;
    if (!ctx.session.preferencesData && tappedBy !== undefined) {
        const savedAt = lastSavedAt.get(tappedBy);
        if (savedAt !== undefined && Date.now() - savedAt < JUST_SAVED_MS) {
            return ctx.answerCallbackQuery(STAFF_TEXTS["staff-preferences-already-saved"]);
        }
    }
    if (await restartIfSessionLost(ctx)) return;
    if (!ctx.session.preferencesData) return;
    if (await ensureActiveStaffTargetsNextMonth(ctx)) {
        await renderCalendar(ctx);
        return ctx.answerCallbackQuery("Оновлено на наступний місяць.");
    }
    const { selectedDays, comment, month } = ctx.session.preferencesData;
    const telegramId = ctx.from?.id;

    if (telegramId !== undefined && !saveDedupe.tryAcquire(`pref-save:${telegramId}`)) {
        // Тихо: человек уже нажал, запись идёт. Сообщение об ошибке здесь
        // выглядело бы как отказ, хотя первое нажатие сохраняется.
        return ctx.answerCallbackQuery("⏳ Зберігаю…");
    }

    await ctx.answerCallbackQuery();

    // Кнопки экрана подтверждения снимаются на время записи: иначе после
    // успеха в чате остаётся «✅ Зберегти» под текстом «ще не надіслані». При
    // неудаче `failSave` перерисует этот же экран — кнопки вернутся.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });

    let waitMessageId: number | undefined;
    const waitMsg = await ctx.reply("⏳ Зберігаю...");
    waitMessageId = waitMsg.message_id;
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
                    await failSave(ctx, waitMessageId);
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
                    logger.error({ telegramId, month: canonicalMonth, reasonCode: saved.reasonCode }, "Canonical preference save failed");
                    // Закрытое окно — не сбой, а конец сбора: повторять нечего,
                    // поэтому экран подтверждения не возвращается.
                    await failSave(
                        ctx,
                        waitMessageId,
                        preferenceSaveFailureText(saved.reasonCode, month ?? "наступний місяць"),
                        saved.reasonCode !== "SCHEDULE_PREFERENCES_CLOSED",
                    );
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
        waitMessageId = undefined;
        // Экран «Перевір і збережи» больше не правда — его место займёт
        // «успішно збережені».
        await ctx.deleteMessage().catch(() => { });
        if (telegramId !== undefined) lastSavedAt.set(telegramId, Date.now());

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
                const welcomeText = `<b>Вітаємо в команді PlayPhoto</b>\n\n` +
                    `⏳ <b>Твій графік готується</b>\n\n` +
                    `Ми вже створюємо твої перші робочі зміни.\n` +
                    `Щойно графік буде готовий — напишемо тут.`;
                // Персональне посилання приходить окремим повідомленням від
                // accessService — зашивати спільний інвайт сюди не можна.
                const welcomeKb = new InlineKeyboard()
                    .text(STAFF_TEXTS["channel-btn-get-link"], "staff_channel_link").row()
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
        // «⏳ Зберігаю...» удаляется и здесь: без этого экран продолжал уверять,
        // что запись идёт, рядом с сообщением о том, что она провалилась.
        await failSave(ctx, waitMessageId);
    } finally {
        // Окно гасит дребезг, пока запись ИДЁТ. После успеха оно держалось ещё
        // до 10 секунд: человек, который сразу открыл форму заново и поправил
        // день, получал «⏳ Зберігаю…» — и не сохранялось ничего. Повторные
        // нажатия на старый экран после успеха ловит `restartIfSessionLost`.
        if (telegramId !== undefined) saveDedupe.release(`pref-save:${telegramId}`);
    }
});

export async function handlePreferenceComment(ctx: MyContext) {
    if (!ctx.session.preferencesData || ctx.session.preferencesData.step !== 'COMMENT') return false;
    const text = ctx.message?.text;
    if (!text) return false;
    // Команда — не комментарий: «/start» на этом шаге ушёл бы в пожелания.
    if (text.startsWith("/")) return false;

    // Шаг брошен: сообщение, пришедшее через полчаса, адресовано не форме.
    // Форма остаётся на подтверждении, сообщение идёт дальше — в підтримку.
    const requestedAt = ctx.session.preferencesData.commentRequestedAt ?? 0;
    if (Date.now() - requestedAt > COMMENT_CAPTURE_MS) {
        ctx.session.preferencesData.step = 'CONFIRM';
        return false;
    }

    // API принимает до 500 символов и отвечает 400 на длиннее — сохранение
    // падало бы при каждой попытке с «спробуй ще раз», без объяснения.
    const trimmed = text.trim();
    if (trimmed.length > COMMENT_MAX_LENGTH) {
        await ctx.reply(STAFF_TEXTS["staff-preferences-comment-too-long"]({ max: COMMENT_MAX_LENGTH, length: trimmed.length }));
        return true;
    }

    ctx.session.preferencesData.comment = trimmed;
    ctx.session.preferencesData.step = 'CONFIRM';
    delete ctx.session.preferencesData.commentRequestedAt;
    await ctx.deleteMessage().catch(() => { });
    await renderConfirmation(ctx);
    return true;
}

/**
 * Что сказать человеку, когда пожелания не сохранились.
 *
 * Закрытое окно — не сбой: «Спробуй ще раз» отправило бы опоздавшего
 * повторять то, что не сработает никогда. Ему нужно знать, что дальше —
 * підтримка.
 */
function preferenceSaveFailureText(
    reasonCode: CanonicalPreferenceReasonCode,
    monthName: string
): string {
    return reasonCode === "SCHEDULE_PREFERENCES_CLOSED"
        ? STAFF_TEXTS["staff-preferences-window-closed"]({ monthName })
        : STAFF_TEXTS["staff-preferences-save-failed"];
}
