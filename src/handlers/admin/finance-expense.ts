import type { MyContext } from "../../types/context.js";
import { InlineKeyboard, Composer } from "grammy";
import { ddsService } from "../../services/finance/dds.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { locationRepository } from "../../repositories/location-repository.js";
import logger from "../../core/logger.js";

const EXPENSE_CATEGORIES = [
    "Логистические затраты",
    "Закупка расходников",
    "Транспортные услуги",
    "Зарплата персонала",
    "Расходы на персонал",
    "Командировочные расходы",
    "Представительские расходы",
    "Маркетинговые расходы",
    "Связь, интернет, ПО",
    "Содержание локации",
    "Возвраты клиентам",
    "Налоги"
];

const DDS_EXPENSE_CATEGORY_MAP: Record<string, string> = {
    "Налоги": "Налоги ФОП"
};

function getDdsExpenseCategory(category: string): string {
    return DDS_EXPENSE_CATEGORY_MAP[category] || category;
}

const ROLE_FOP_MAP: Record<string, string> = {
    'CO_FOUNDER': 'Счёт ФОП Гупалова',
    'SUPPORT': 'Счёт ФОП Посредникова',
    'SUPER_ADMIN': 'Счёт ФОП Кузнецов',
    'HR_LEAD': 'Счёт ФОП Гупалова'
};

export const expenseHandlers = new Composer<MyContext>();

const EXPENSE_STEPS = new Set([
    "expense_amount",
    "expense_category",
    "expense_location",
    "expense_comment",
    "expense_confirm",
]);

function isExpenseStep(step?: string) {
    return !!step && EXPENSE_STEPS.has(step);
}

function clearExpenseFlow(ctx: MyContext) {
    if (ctx.session.adminFlow === "EXPENSE") {
        delete ctx.session.adminFlow;
    }
    ctx.session.step = "idle";
    ctx.session.candidateData = {};
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
}

export async function startExpenseFlow(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const userRole = await getUserAdminRole(BigInt(telegramId));
    const fopName = ROLE_FOP_MAP[userRole || ''] || 'Готівка';

    ctx.session.adminFlow = "EXPENSE";
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
    ctx.session.step = "expense_amount";
    ctx.session.candidateData = { expenseFop: fopName } as any;

    await ctx.reply(`💸 <b>New Expense</b>\n\nAccount: <b>${fopName}</b>\n\nEnter amount (UAH):`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✖️ Cancel", "expense_cancel").danger()
    });
}

expenseHandlers.callbackQuery("expense_cancel", async (ctx) => {
    clearExpenseFlow(ctx);
    await ctx.answerCallbackQuery("❌ Cancelled.").catch(() => { });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.reply("❌ Expense creation cancelled.", {
        reply_markup: new InlineKeyboard().text("🏠 Back to Finance", "admin_finance_back")
    });
});

export async function handleExpenseText(ctx: MyContext, next: () => Promise<void>) {
    const step = ctx.session.step || "";
    const messageText = ctx.message?.text;
    if (!messageText) {
        await next();
        return;
    }

    if (ctx.session.adminFlow === "EXPENSE" && !isExpenseStep(step)) {
        clearExpenseFlow(ctx);
        await next();
        return;
    }

    if (step === "expense_amount") {
        const amountText = messageText.replace(',', '.');
        const amount = parseFloat(amountText);

        if (isNaN(amount) || amount <= 0) {
            await ctx.reply("❌ Invalid amount. please enter a number like 1500 or 250.50");
            return;
        }

        (ctx.session.candidateData as any).expenseAmount = amount;
        ctx.session.step = "expense_category";

        const categoryKeyboard = new InlineKeyboard();
        EXPENSE_CATEGORIES.forEach((cat, index) => {
            categoryKeyboard.text(cat, `exp_cat_${index}`);
            if ((index + 1) % 2 === 0) categoryKeyboard.row();
        });

        await ctx.reply(`💰 Amount: <b>${amount} UAH</b>\n📂 Select Category:`, {
            parse_mode: "HTML",
            reply_markup: categoryKeyboard
        });
        return;
    }

    if (step === "expense_category") {
        await ctx.reply("📂 Please select a category using the buttons above.");
        return;
    }

    if (step === "expense_location") {
        await ctx.reply("📍 Please select a location/project using the buttons above.");
        return;
    }

    if (step === "expense_comment") {
        const comment = messageText;
        (ctx.session.candidateData as any).expenseComment = comment;

        const fopName = (ctx.session.candidateData as any).expenseFop;
        const amount = (ctx.session.candidateData as any).expenseAmount;
        const category = (ctx.session.candidateData as any).expenseCategory;
        const ddsCategory = getDdsExpenseCategory(category);
        const locationName = (ctx.session.candidateData as any).expenseLocation;

        const dateStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
        const finalAmount = -Math.abs(amount);

        const summary = `💸 <b>Confirm Expense?</b>\n\n` +
            `📅 Date: ${dateStr}\n` +
            `💳 Account: <b>${fopName}</b>\n` +
            `💰 Amount: <b>${finalAmount} UAH</b>\n` +
            `📂 Category: ${ddsCategory}\n` +
            `📍 Location: ${locationName}\n` +
            `📝 Comment: ${comment}`;

        ctx.session.step = "expense_confirm";

        await ctx.reply(summary, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ Save", "exp_confirm_save")
                .text("✖️ Cancel", "expense_cancel").danger()
        });
        return;
    }

    if (step === "expense_confirm") {
        await ctx.reply("✅ Please save or cancel the expense using the buttons above.");
        return;
    }

    await next();
}

expenseHandlers.on("message:text", handleExpenseText);

expenseHandlers.callbackQuery(/^exp_cat_(\d+)$/, async (ctx) => {
    if (ctx.session.step !== "expense_category") return ctx.answerCallbackQuery("Invalid step").catch(() => { });

    const categoryIndex = parseInt(ctx.match![1]!);
    const category = EXPENSE_CATEGORIES[categoryIndex] || "Other";
    (ctx.session.candidateData as any).expenseCategory = category;

    await ctx.answerCallbackQuery().catch(() => { });
    ctx.session.step = "expense_location";

    const locations = await locationRepository.findAllActive();
    const locKeyboard = new InlineKeyboard()
        .text("🏢 PlayPhoto (General)", "exp_loc_PlayPhoto").row();

    // Map of Ukrainian city names -> Short identifiers for buttons
    const CITY_SHORT_MAP: Record<string, string> = {
        'Київ': 'К',
        'Львів': 'Л',
        'Харків': 'Х',
        'Рівне': 'Р',
        'Черкаси': 'Ч',
        'Запоріжжя': 'З',
        'Коломия': 'Кол',
        'Самбір': 'С',
        'Шептицький': 'Ш',
        'Хмельницький': 'Хм',
    };

    locations.forEach((loc, index) => {
        const shortCity = CITY_SHORT_MAP[loc.city] || loc.city;
        const buttonLabel = `${loc.name} (${shortCity})`;
        
        locKeyboard.text(buttonLabel, `exp_loc_${loc.id}`);
        if ((index + 1) % 2 === 0) locKeyboard.row();
    });

    await ctx.reply(`📂 Category: <b>${category}</b>\n\n📍 Select Location/Project (Column G):`, {
        parse_mode: "HTML",
        reply_markup: locKeyboard
    });
});

expenseHandlers.callbackQuery(/^exp_loc_(.+)$/, async (ctx) => {
    if (ctx.session.step !== "expense_location") return ctx.answerCallbackQuery("Invalid step").catch(() => { });

    const locId = ctx.match![1]!;
    let locationName = "PlayPhoto";

    if (locId !== "PlayPhoto") {
        const locations = await locationRepository.findAllActive();
        const selectedLoc = locations.find(l => l.id === locId);
        if (selectedLoc) locationName = selectedLoc.name;
    }

    (ctx.session.candidateData as any).expenseLocation = locationName;
    await ctx.answerCallbackQuery().catch(() => { });

    ctx.session.step = "expense_comment";
    await ctx.reply(`📍 Location: <b>${locationName}</b>\n\nEnter comment (description):`, { parse_mode: "HTML" });
});

expenseHandlers.callbackQuery("exp_confirm_save", async (ctx) => {
    if (ctx.session.step !== "expense_confirm") return ctx.answerCallbackQuery("Invalid step").catch(() => { });

    const fopName = (ctx.session.candidateData as any).expenseFop;
    const amount = (ctx.session.candidateData as any).expenseAmount;
    const category = (ctx.session.candidateData as any).expenseCategory;
    const ddsCategory = getDdsExpenseCategory(category);
    const locationName = (ctx.session.candidateData as any).expenseLocation;
    const comment = (ctx.session.candidateData as any).expenseComment;

    await ctx.answerCallbackQuery("Saving...").catch(() => { });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });

    clearExpenseFlow(ctx);
    const loadingMsg = await ctx.reply("⏳ Saving to DDS...");

    const dateStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    const finalAmount = -Math.abs(amount);

    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for Google Sheets")), 15000));
        const request = ddsService.addTransaction({
            date: dateStr,
            amount: finalAmount,
            fop: fopName,
            category: ddsCategory,
            comment: comment,
            location: locationName
        });
        await Promise.race([request, timeout]);

        await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => { });
        await ctx.reply("✅ Saved successfully!", {
            reply_markup: new InlineKeyboard().text("🏠 Back to Finance", "admin_finance_back")
        });
    } catch (e: any) {
        logger.error({ err: e }, "Failed to save expense");
        await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => { });
        await ctx.reply(`❌ Error saving to DDS: ${e.message}`);
    }
});
