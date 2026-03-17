import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { userRepository } from "../repositories/user-repository.js";
import { preferencesService } from "../services/preferences-service.js";
import logger from "../core/logger.js";

type MyConversation = Conversation<MyContext>;

export async function preferencesConversation(conversation: MyConversation, ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // 1. Resolve Staff Info
    const user = await conversation.external(() => userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId)));
    if (!user || !user.staffProfile || !user.staffProfile.isActive) {
        await ctx.reply("❌ Ця функція доступна тільки для активних фотографів.");
        return;
    }

    // Robustness: fallback if surnameNameDot is missing
    const staffNameForTable = (user.staffProfile as any).surnameNameDot || user.staffProfile.fullName;

    // 2. Calculate Next Month
    // For deterministic replay in conversations, we should ideally use a fixed time or get it once from external
    const kyivNow = await conversation.external(() => {
        const d = new Date();
        return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    });

    const nextMonthDate = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
    const monthName = nextMonthDate.toLocaleString('uk-UA', { month: 'long' });
    const year = nextMonthDate.getFullYear();
    const daysInMonth = new Date(nextMonthDate.getFullYear(), nextMonthDate.getMonth() + 1, 0).getDate();

    let selectedDays = new Set<number>();
    let comment = "";

    // Main interaction loop to allow "Back" functionality
    while (true) {
        // --- STEP 1: Date Selection Loop ---
        let menuMsgId: number | undefined;

        while (true) {
            const kb = new InlineKeyboard();
            for (let d = 1; d <= daysInMonth; d++) {
                const isSelected = selectedDays.has(d);
                kb.text(isSelected ? `✅ ${d}` : `${d}`, `toggle_pref_day_${d}`);
                if (d % 7 === 0) kb.row();
            }

            if (selectedDays.size === 0) {
                kb.row().text("✨ Немає побажань (все вільно)", "pref_finish_none");
            } else {
                kb.row().text(`✅ Готово (${selectedDays.size} дн.)`, "pref_finish");
            }
            kb.row().text("❌ Скасувати", "pref_cancel");

            const text = `🗓 <b>Побажання (${monthName})</b>\n\n` +
                `Познач дні, коли ти <b>НЕ МОЖЕШ</b> вийти на зміну (твої вихідні). 🚫\n\n` +
                `<i>(Натисни на дати нижче)</i>`;

            if (!menuMsgId) {
                const msg = await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
                menuMsgId = msg.message_id;
            } else {
                await ctx.api.editMessageText(ctx.chat!.id, menuMsgId, text, { parse_mode: "HTML", reply_markup: kb }).catch(() => { });
            }

            const selection = await conversation.waitFor("callback_query:data");
            const data = selection.callbackQuery.data;

            if (data === "pref_cancel") {
                await selection.answerCallbackQuery("❌ Заповнення скасовано.");
                if (menuMsgId) await ctx.api.deleteMessage(ctx.chat!.id, menuMsgId).catch(() => { });
                const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
                await showStaffHub(ctx);
                return;
            }

            await selection.answerCallbackQuery();

            if (data === "pref_finish" || data === "pref_finish_none") {
                if (data === "pref_finish_none") selectedDays.clear();
                break;
            }

            if (data.startsWith("toggle_pref_day_")) {
                const day = parseInt(data.replace("toggle_pref_day_", ""));
                if (selectedDays.has(day)) selectedDays.delete(day);
                else selectedDays.add(day);
            }
        }

        // --- STEP 2: Comment Step ---
        const daysStr = selectedDays.size > 0
            ? Array.from(selectedDays).sort((a, b) => a - b).join(", ")
            : "Немає побажань за вихідними (працюю у будь-який день)";

        const commentPrompt = `🗓 <b>Вибрані вихідні:</b> ${daysStr}\n\n` +
            `Напиши коментар або додаткові побажання (бажаю більше змін, потрібно більше змін на Х локації).\n\n` +
            `<i>Якщо коментарів немає — просто надішли крапку або натисни кнопку нижче:</i>`;

        const commentKb = new InlineKeyboard()
            .text("⬅️ Назад до календаря", "pref_back_to_cal").row()
            .text("⏩ Без коментаря", "pref_no_comment");

        await ctx.api.editMessageText(ctx.chat!.id, menuMsgId, commentPrompt, {
            parse_mode: "HTML",
            reply_markup: commentKb
        });

        const commentResult = await conversation.waitFor(["message:text", "callback_query:data"]);

        if (commentResult.callbackQuery?.data === "pref_back_to_cal") {
            continue; // Back to calendar loop
        }

        if (commentResult.callbackQuery?.data === "pref_no_comment") {
            comment = "";
        } else {
            comment = commentResult.message?.text || "";
            if (comment === "." || comment.toLowerCase() === "ні" || comment.toLowerCase() === "нет") comment = "";
            if (commentResult.message) {
                await ctx.api.deleteMessage(ctx.chat!.id, commentResult.message.message_id).catch(() => { });
            }
        }

        // --- STEP 3: Final Confirmation ---
        const summary = `📝 <b>Підтвердження побажань:</b>\n\n` +
            `👤 Фотограф: <b>${user.staffProfile.fullName}</b>\n` +
            `📅 Місяць: <b>${monthName} ${year}</b>\n` +
            `🚫 Вихідні: <b>${daysStr}</b>\n` +
            `💬 Коментар: ${comment || '<i>відсутній</i>'}\n\n` +
            `Зберегти ці дані в таблицю?`;

        const confirmKb = new InlineKeyboard()
            .text("✅ Так, зберегти", "pref_confirm_save")
            .text("🔄 Почати спочатку", "pref_restart")
            .row()
            .text("❌ Скасувати", "pref_cancel");

        await ctx.api.editMessageText(ctx.chat!.id, menuMsgId as number, summary, { parse_mode: "HTML", reply_markup: confirmKb }).catch(() => { });

        const finalDecision = await conversation.waitFor("callback_query:data");
        const finalData = finalDecision.callbackQuery.data;

        if (finalData === "pref_confirm_save") {
            await finalDecision.answerCallbackQuery();
            const waitMsg = await ctx.reply("⏳ Зберігаю дані в таблицю...");

            try {
                const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
                await conversation.external(() => preferencesService.savePreference({
                    timestamp,
                    fullNameDot: staffNameForTable,
                    unworkableDays: daysStr,
                    comment: comment
                }));

                // Mark PendingReply as confirmed if exists to stop future pings
                await conversation.external(async () => {
                    const { pendingReplyRepository } = await import("../repositories/pending-reply-repository.js");
                    const pending = await pendingReplyRepository.findMany({
                        userId: BigInt(telegramId),
                        status: "pending"
                    });

                    for (const p of pending) {
                        await pendingReplyRepository.update(p.id, { status: "confirmed", respondedAt: new Date() });
                    }
                });

                await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => { });
                if (menuMsgId) await ctx.api.deleteMessage(ctx.chat!.id, menuMsgId).catch(() => { });
                await ctx.reply("✅ <b>Твої побажання успішно збережені!</b> Дякуємо. 🌸\n\nАдміністратор врахує їх при складанні графіка.", { parse_mode: "HTML" });
                const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
                await showStaffHub(ctx);
                return;
            } catch (e: any) {
                logger.error({ err: e.message }, "Error saving preferences");
                if (menuMsgId) await ctx.api.deleteMessage(ctx.chat!.id, menuMsgId).catch(() => { });
                await ctx.reply(`❌ Помилка при збереженні: ${e.message}. Будь ласка, повідомте адміністратора.`);
                const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
                await showStaffHub(ctx);
                return;
            }
        } else if (finalData === "pref_restart") {
            await finalDecision.answerCallbackQuery();
            selectedDays.clear();
            comment = "";
            continue;
        } else {
            await finalDecision.answerCallbackQuery("❌ Заповнення скасовано.");
            if (menuMsgId) await ctx.api.deleteMessage(ctx.chat!.id, menuMsgId).catch(() => { });
            const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
            await showStaffHub(ctx);
            return;
        }
    }
}
