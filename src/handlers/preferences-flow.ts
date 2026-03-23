import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { userRepository } from "../repositories/user-repository.js";
import { preferencesService } from "../services/preferences-service.js";
import type { PreferenceData } from "../services/preferences-service.js";
import { pendingReplyRepository } from "../repositories/pending-reply-repository.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";


export const preferencesHandlers = new Composer<MyContext>();

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

preferencesHandlers.callbackQuery("pref_opt_out", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.answerCallbackQuery();

    // Mark all pending preference replies as declined → stops pinger
    await pendingReplyRepository.updateMany(
        { userId: BigInt(userId), status: "pending" },
        { status: "declined", respondedAt: new Date() }
    );

    // Log opt-out to Google Sheets so admin sees who refused
    try {
        const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));
        const fullName = user?.staffProfile?.fullName || user?.candidate?.fullName || "Невідомий";
        const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

        await preferencesService.savePreference({
            timestamp,
            fullNameDot: fullName,
            unworkableDays: "🚫 Відмовилась заповнювати",
            comment: ""
        });
    } catch (e) {
        logger.error({ err: e, userId }, "Failed to log pref opt-out to Sheets");
    }

    await ctx.answerCallbackQuery("🚫 Нагадування вимкнено.");
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
});

export async function startPreferencesFlow(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));
    const isEligible = user?.staffProfile?.isActive || (user?.candidate?.currentStep === "FIRST_SHIFT");

    if (!isEligible) {
        return ctx.reply("❌ Ця функція поки що недоступна.");
    }

    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

    const isNewCandidate = user?.candidate?.currentStep === "FIRST_SHIFT";
    const isLateInMonth = kyivNow.getDate() >= 23;

    // Active staff after 23rd → jump straight to next month
    // New candidates after 23rd → start with current month, then chain to next
    const monthOffset = (!isNewCandidate && isLateInMonth) ? 1 : 0;
    const targetMonthDate = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + monthOffset, 1);

    const fullName = user?.staffProfile?.fullName || user?.candidate?.fullName || "";

    // Check if photographer already filled preferences — offer to update
    if (!isNewCandidate && fullName) {
        const alreadyFilled = await preferencesService.hasExistingPreference(fullName);
        if (alreadyFilled && !ctx.session.preferencesData?.forceEdit) {
            const kb = new InlineKeyboard()
                .text("✏️ Змінити побажання", "pref_force_edit")
                .text("⬅️ Назад", "staff_hub_nav");
            await ScreenManager.renderScreen(ctx,
                `✅ <b>Ти вже заповнив/ла побажання на цей місяць!</b>\n\nЯкщо хочеш змінити — натисни кнопку нижче.`,
                kb, { forceNew: true });
            return;
        }
    }
    delete ctx.session.preferencesData?.forceEdit;

    ctx.session.preferencesData = {
        month: targetMonthDate.toLocaleString('uk-UA', { month: 'long' }),
        year: targetMonthDate.getFullYear(),
        selectedDays: [],
        comment: "",
        step: 'CALENDAR',
        forceNextMonth: isNewCandidate && isLateInMonth
    };

    await renderCalendar(ctx);
}

async function renderCalendar(ctx: MyContext) {
    if (!ctx.session.preferencesData) return;
    const { month, selectedDays, year } = ctx.session.preferencesData;

    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

    const monthsMap: Record<string, number> = {
        'січень': 0, 'лютий': 1, 'березень': 2, 'квітень': 3, 'травень': 4, 'червень': 5,
        'липень': 6, 'серпень': 7, 'вересень': 8, 'жовтень': 9, 'листопад': 10, 'грудень': 11
    };
    const targetMonthIndex = monthsMap[month?.toLowerCase() || ''];
    const isCurrentMonth = targetMonthIndex === kyivNow.getMonth() && year === kyivNow.getFullYear();

    const daysInMonth = new Date(year || kyivNow.getFullYear(), (targetMonthIndex ?? 0) + 1, 0).getDate();

    const kb = new InlineKeyboard();
    const selected = new Set(selectedDays || []);

    // Standard calendar grid: 7 columns
    for (let d = 1; d <= daysInMonth; d++) {
        const isSelected = selected.has(d);
        const isTodayOrPast = isCurrentMonth && d <= kyivNow.getDate();

        if (isTodayOrPast) {
            // Block today and past days
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
    kb.row().text("❌ Скасувати", "pref_cancel_flow");

    const selectionHint = isCurrentMonth
        ? `<i>(Вибір вихідних доступний з завтрашнього дня)</i>`
        : `<i>(Натисни на дати нижче)</i>`;

    const text = `🗓 <b>Побажання (${month})</b>\n\n` +
        `Познач дні, коли ти <b>НЕ МОЖЕШ</b> вийти на зміну (твої вихідні). 🚫\n\n` +
        selectionHint;

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
}

preferencesHandlers.callbackQuery(/^pref_toggle_(\d+)$/, async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery("Сесія застаріла.");
    const day = parseInt(ctx.match![1]!);
    const selected = new Set(ctx.session.preferencesData.selectedDays);
    if (selected.has(day)) selected.delete(day);
    else selected.add(day);
    ctx.session.preferencesData.selectedDays = Array.from(selected);
    await renderCalendar(ctx);
    await ctx.answerCallbackQuery();
});

preferencesHandlers.callbackQuery(["pref_to_comment", "pref_to_comment_none"], async (ctx) => {
    if (!ctx.session.preferencesData) return ctx.answerCallbackQuery("Сесія застаріла.");
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

    const summary = `📝 <b>Підтвердження:</b>\n\n👤 Ім'я: <b>${name}</b>\n📅 Місяць: <b>${month} ${year}</b>\n🚫 Вихідні: <b>${daysStr}</b>\n💬 Коментар: ${comment || 'відсутній'}`;
    const kb = new InlineKeyboard().text("✅ Зберегти", "pref_save_final").text("🔄 Спочатку", "pref_restart_flow").row().text("❌ Скасувати", "pref_cancel_flow");

    await ScreenManager.renderScreen(ctx, summary, kb, { pushToStack: true, manualMenuId: "staff-preferences" });
}

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
    const { selectedDays, comment, month } = ctx.session.preferencesData;
    const telegramId = ctx.from?.id;
    await ctx.answerCallbackQuery();

    const waitMsg = await ctx.reply("⏳ Зберігаю...");
    try {
        const user = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId!));
        const staffNameForTable = user?.staffProfile?.fullName || user?.candidate?.fullName || "Фотограф";
        const daysStr = selectedDays && selectedDays.length > 0 ? selectedDays.sort((a, b) => a - b).join(", ") : "Немає побажань";
        const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

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

        // Mark pending reply as confirmed → stops pinger reminders
        await pendingReplyRepository.updateMany(
            { userId: BigInt(telegramId!), status: "pending" },
            { status: "confirmed", respondedAt: new Date() }
        );

        // Mark this user as having filled preferences for this month → broadcast will skip them
        const prefFilledKey = `pref_filled:${telegramId}:${month}`;
        await redis.set(prefFilledKey, "1", "EX", 40 * 24 * 60 * 60); // 40 days TTL

        const kyivNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const currentMonthName = kyivNow.toLocaleString('uk-UA', { month: 'long' });
        const isCurrentMonth = (month || "").toLowerCase() === currentMonthName.toLowerCase();
        const shouldMoveToNext = !!ctx.session.preferencesData.forceNextMonth && isCurrentMonth;

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

            const isNewCandidate = user?.candidate?.status === 'AWAITING_FIRST_SHIFT';

            if (isNewCandidate) {
                // Auto-hire: create StaffProfile + flip role, but DON'T send "schedule ready" yet.
                // The real welcome ("Графік готовий!") comes later when admin syncs shifts.
                try {
                    const { staffRepository } = await import("../repositories/staff-repository.js");
                    const { candidateRepository } = await import("../repositories/candidate-repository.js");
                    const { accessService } = await import("../services/access-service.js");

                    const candidate = user.candidate!;

                    // Create StaffProfile (isWelcomeSent defaults to false)
                    if (!user.staffProfile) {
                        const createData: any = {
                            user: { connect: { id: user.id } },
                            fullName: candidate.fullName || "Фотограф",
                            isActive: true
                        };
                        if (candidate.locationId) createData.location = { connect: { id: candidate.locationId } };
                        await staffRepository.create(createData);
                    }

                    // Update candidate status to HIRED + flip role to STAFF
                    await candidateRepository.update(candidate.id, { status: 'HIRED' as any });
                    await userRepository.update(user.id, { role: 'STAFF' as any });

                    // Sync channel access
                    await accessService.syncUserAccess(user.telegramId, "Auto-hire after onboarding").catch(() => { });

                    logger.info({ userId: user.id }, "🚀 Auto-hire completed (waiting for schedule sync)");
                } catch (hireErr) {
                    logger.error({ err: hireErr, userId: user.id }, "❌ Auto-hire failed, candidate stays in AWAITING_FIRST_SHIFT");
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
        const wasNewCandidate = user?.candidate?.status === 'AWAITING_FIRST_SHIFT';
        if (wasNewCandidate) {
            const { ADMIN_IDS } = await import("../config.js");
            if (ADMIN_IDS.length > 0) {
                const adminNotifyText = `📅 <b>New Schedule Preferences!</b>\n\n` +
                    `👤 Staff: <b>${staffNameForTable}</b>\n` +
                    `📅 Month: <b>${month}</b>\n` +
                    `🚫 Weekends: <b>${daysStr}</b>\n` +
                    `💬 Comment: ${comment || 'none'}\n\n` +
                    (shouldMoveToNext ? `⏳ Waiting for the next month to be filled...` :
                        `✅ Auto-hired! Please add shifts to the schedule.`);

                await ctx.api.sendMessage(ADMIN_IDS[0]!, adminNotifyText, {
                    parse_mode: "HTML"
                });
            }
        }
    } catch (e: any) {
        logger.error({ err: e }, "Pref save failed");
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
