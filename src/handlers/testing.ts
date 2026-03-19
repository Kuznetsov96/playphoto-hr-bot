import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../types/context.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { ADMIN_IDS, MENTOR_IDS } from "../config.js";
import { z } from "zod";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";

const NDASchema = z.object({
    fullName: z.string().min(5, "ПІБ має бути не менше 5 символів").max(100),
    passportData: z.string().min(5, "Введіть коректні паспортні дані"),
    address: z.string().min(10, "Адреса занадто коротка"),
    phone: z.string().regex(/^\+?[\d\s-]{10,15}$/, "Невірний формат телефону")
});

export const testingHandlers = new Composer<MyContext>();

// --- TRAINING TEST MULTI-STAGE (Stateless Callbacks) ---

testingHandlers.callbackQuery(/^start_training_test_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1];
    if (!candId) return ctx.answerCallbackQuery("Помилка: Не вдалося знайти ID кандидата. ❌");

    const cand = await candidateRepository.findById(candId);
    if (!cand) return ctx.answerCallbackQuery("Кандидат не знайдений. ❌");

    await ctx.answerCallbackQuery();
    
    // Initialize test score in session
    ctx.session.candidateData = { id: candId, trainingScore: 0 };

    await ctx.reply("📚 <b>Тест по матеріалах навчання</b>\n\nДай відповідь на кілька запитань, щоб підтвердити свої знання.", { parse_mode: "HTML" });

    await ctx.reply("1️⃣ Чи дозволено запізнюватися на зміну навіть на 5 хвилин?", {
        reply_markup: new InlineKeyboard().text("Так", `test_1_yes_${candId}`).text("Ні", `test_1_no_${candId}`)
    });
});

testingHandlers.callbackQuery(/^test_1_(yes|no)_(.+)$/, async (ctx) => {
    const answer = ctx.match![1]!;
    const candId = ctx.match![2]!;
    await ctx.answerCallbackQuery();

    if (answer === "yes") {
        await ctx.reply("❌ Неправильно. Пунктуальність — наш пріоритет.");
    } else {
        if (ctx.session.candidateData) ctx.session.candidateData.trainingScore = (ctx.session.candidateData.trainingScore || 0) + 1;
        await ctx.reply("✅ Вірно! Пунктуальність понад усе.");
    }

    await ctx.reply("2️⃣ Що робити, якщо клієнт незадоволений результатом фотосесії?", {
        reply_markup: new InlineKeyboard()
            .text("Сперечатися", `test_2_bad_${candId}`).row()
            .text("Ввічливо заспокоїти та покликати адміна", `test_2_good_${candId}`)
    });
});

testingHandlers.callbackQuery(/^test_2_(bad|good)_(.+)$/, async (ctx) => {
    const answer = ctx.match![1]!;
    const candId = ctx.match![2]!;
    await ctx.answerCallbackQuery();

    if (answer === "bad") {
        await ctx.reply("❌ Неправильно. Ми завжди цінуємо сервіс.");
    } else {
        if (ctx.session.candidateData) ctx.session.candidateData.trainingScore = (ctx.session.candidateData.trainingScore || 0) + 1;
        await ctx.reply("✅ Правильно! Сервіс — запорука успіху.");
    }

    // Finish test
    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    const finalScore = ctx.session.candidateData?.trainingScore || 0;

    const kb = new InlineKeyboard().text("👨‍💼 Написати Адміністратору", "contact_hr");

    await ctx.reply(CANDIDATE_TEXTS["training-test-success"], { 
        parse_mode: "HTML",
        reply_markup: kb
    });

    await candidateRepository.update(candId, {
        status: CandidateStatus.OFFLINE_STAGING as any,
        currentStep: FunnelStep.FIRST_SHIFT,
        testPassed: true,
        mentorScore: finalScore,
        notificationSent: false
    } as any);

    const notifyMsg = `🎓 <b>Кандидатка склала тест і готова до офлайн-стажування!</b>\n\n` +
        `👤 Ім'я: <b>${cand.fullName}</b>\n` +
        `🏙️ Місто: ${cand.city}\n` +
        `📍 Локація: ${cand.location?.name || 'Не вказано'}\n` +
        `📊 Результат тесту: <b>${finalScore} / 2</b>\n` +
        `📞 Telegram: @${cand.user.username || 'немає'}\n\n` +
        `⚠️ <b>Дія потрібна:</b> Будь ласка, домовся про час першого виходу на стажування.`;

    const mainAdminId = ADMIN_IDS[0];
    if (mainAdminId) {
        const adminKb = new InlineKeyboard().text("👤 Переглянути профіль", `view_candidate_${candId}`);
        await ctx.api.sendMessage(mainAdminId, notifyMsg, { 
            parse_mode: "HTML", 
            reply_markup: adminKb 
        }).catch(() => { });
    }

    for (const mentorId of MENTOR_IDS) {
        try {
            await ctx.api.sendMessage(mentorId, notifyMsg, { parse_mode: "HTML" });
        } catch (_) { }
    }
});


// --- NDA READING (Before Staging) ---

testingHandlers.callbackQuery(/^confirm_nda_(.+)$/, async (ctx: MyContext) => {
    const candId = ctx.match![1]!;
    if (!candId) return ctx.answerCallbackQuery("Помилка: ID не знайдено.");

    const cand = await candidateRepository.findById(candId);
    if (!cand) return ctx.answerCallbackQuery("Кандидат не знайдений. ❌");

    await candidateRepository.update(candId, {
        ndaConfirmedAt: new Date(),
        status: "KNOWLEDGE_TEST" as any
    } as any);

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery("✅ Ознайомлення з NDA зафіксовано!");

    await ctx.api.sendMessage(
        Number(cand.user.telegramId),
        CANDIDATE_TEXTS["nda-confirmed-start-quiz"],
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📝 Почати тест", `start_training_test_${candId}`)
        }
    );
});
