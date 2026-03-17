import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { ScreenManager } from "../utils/screen-manager.js";
import { cleanupMessages } from "../utils/cleanup.js";
import logger from "../core/logger.js";
import { CandidateSchema, parseBirthDate } from "../schemas/candidate-schema.js";
import { menuRegistry } from "../utils/menu-registry.js";
import { Menu } from "@grammyjs/menu";
import { CandidateStatus } from "@prisma/client";

export const onboardingHandlers = new Composer<MyContext>();

const STEPS = {
    FULL_NAME: 'ONB_FULL_NAME',
    BIRTH_DATE: 'ONB_BIRTH_DATE',
    PHONE: 'ONB_PHONE',
    EMAIL: 'ONB_EMAIL',
    PASSPORT_FRONT: 'ONB_PASSPORT_FRONT',
    PASSPORT_BACK: 'ONB_PASSPORT_BACK',
    PASSPORT_ANNEX: 'ONB_PASSPORT_ANNEX',
    IBAN: 'ONB_IBAN',
    INSTAGRAM: 'ONB_INSTAGRAM',
    FINAL: 'ONB_FINAL'
};

// --- MENUS ---
export const onboardingConfirmBirthDateMenu = new Menu<MyContext>("onb-confirm-bd");
menuRegistry.register(onboardingConfirmBirthDateMenu);

onboardingConfirmBirthDateMenu
    .text("✅ Все вірно", async (ctx) => {
        await ctx.answerCallbackQuery();
        ctx.session.candidateData.step = STEPS.PHONE;
        await ScreenManager.renderScreen(ctx, "📱 <b>Твій номер телефону:</b>\n\nНапиши у форматі +380...", undefined, { pushToStack: true });
    })
    .text("📝 Змінити", async (ctx) => {
        await ctx.answerCallbackQuery();
        ctx.session.candidateData.step = STEPS.BIRTH_DATE;
        await ScreenManager.renderScreen(ctx, "🎈 <b>Введи правильну дату народження:</b>\n\nФормат: ДД.ММ.РРРР (наприклад, 15.05.2000)", undefined, { pushToStack: true });
    });

onboardingHandlers.use(onboardingConfirmBirthDateMenu);

onboardingHandlers.callbackQuery("start_onboarding_data", async (ctx) => {
    await ctx.answerCallbackQuery();
    await cleanupMessages(ctx);

    const telegramId = ctx.from!.id;
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) return;

    const allowedStatuses: CandidateStatus[] = [
        CandidateStatus.READY_FOR_HIRE,
        CandidateStatus.AWAITING_FIRST_SHIFT
    ];

    if (!allowedStatuses.includes(candidate.status)) {
        await ctx.answerCallbackQuery("⚠️ Цей етап ще недоступний. Оновлюю меню... ✨").catch(() => { });
        const { showCandidateStatus } = await import("../utils/candidate-ui.js");
        await showCandidateStatus(ctx, candidate);
        return;
    }

    // Critical: Initialize session with fresh data to avoid state leakage from previous attempts
    ctx.session.candidateData = {
        step: STEPS.FULL_NAME,
        passportPhotoIds: []
    };

    const startText = `🔒 <b>Твої дані під захистом.</b>\n\n` +
        `Ми використовуємо сучасні стандарти безпеки, щоб твої документи залишалися суворо конфіденційними. Вони використовуються виключно для підготовки договору та початку нашої співпраці.\n\n` +
        `Напиши, будь ласка, своє повне Прізвище, Ім'я та По Батькові (як у паспорті):`;

    await ScreenManager.renderScreen(ctx, startText, undefined, { pushToStack: true });
});

onboardingHandlers.on("message:text", async (ctx, next) => {
    const data = ctx.session.candidateData;
    const step = data?.step;

    if (!step || !step.startsWith('ONB_') || step === STEPS.FINAL) return next();

    const text = ctx.message.text.trim();
    const telegramId = ctx.from!.id;
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) return next();

    // SMI: Clean up user input immediately
    await ctx.deleteMessage().catch(() => { });

    try {
        if (step === STEPS.FULL_NAME) {
            const val = CandidateSchema.shape.fullName.safeParse(text);
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>\n\nСпробуй ще раз (Прізвище Ім'я По Батькові):`);
                return;
            }
            ctx.session.candidateData.fullName = val.data;

            const bd = candidate.birthDate;
            if (bd) {
                const bdStr = bd.toLocaleDateString('uk-UA');
                // Ensure we stay in ONB flow but wait for button click
                await ScreenManager.renderScreen(ctx, `🎈 <b>Твоя дата народження:</b> ${bdStr}\n\nВсе правильно?`, "onb-confirm-bd", { pushToStack: true });
            } else {
                ctx.session.candidateData.step = STEPS.BIRTH_DATE;
                await ScreenManager.renderScreen(ctx, "🎈 <b>Коли твій день народження?</b>\n\nНапиши у форматі ДД.ММ.РРРР (наприклад, 15.05.2000):", undefined, { pushToStack: true });
            }
        }
        else if (step === STEPS.BIRTH_DATE) {
            const date = parseBirthDate(text);
            if (!date) {
                await ScreenManager.renderScreen(ctx, "⚠️ <b>Формат має бути ДД.ММ.РРРР.</b>\n\nБудь ласка, спробуй ще раз (наприклад, 15.05.1998):");
                return;
            }
            const val = CandidateSchema.shape.birthDate.safeParse(date);
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>\n\nБудь ласка, спробуй ще раз:`);
                return;
            }
            ctx.session.candidateData.birthDate = date.toISOString();

            ctx.session.candidateData.step = STEPS.PHONE;
            await ScreenManager.renderScreen(ctx, "📱 <b>Твій номер телефону:</b>\n\nНапиши у форматі +380...", undefined, { pushToStack: true });
        }
        else if (step === STEPS.PHONE) {
            const sanitized = text.replace(/\s+/g, '').replace(/-/g, '').replace(/\(/g, '').replace(/\)/g, '');
            const val = CandidateSchema.shape.phone.safeParse(sanitized);
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>\n\nПриклад: +380931234567`);
                return;
            }
            ctx.session.candidateData.phone = val.data;

            ctx.session.candidateData.step = STEPS.EMAIL;
            await ScreenManager.renderScreen(ctx, "📧 <b>Твій Email:</b>\n\nВін потрібен для офіційного листування та NDA:", undefined, { pushToStack: true });
        }
        else if (step === STEPS.EMAIL) {
            const val = CandidateSchema.shape.email.safeParse(text.toLowerCase());
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>`);
                return;
            }
            ctx.session.candidateData.email = val.data;

            ctx.session.candidateData.step = STEPS.PASSPORT_FRONT;
            await ScreenManager.renderScreen(ctx, "📸 <b>Тепер документи.</b>\n\nНадішли, будь ласка, фото <b>лицьової сторони</b> паспорта (або ID-картки). Також можна використовувати скріншот з застосунку <b>Дія</b>. 📱", undefined, { pushToStack: true });
        }
        else if ([STEPS.PASSPORT_FRONT, STEPS.PASSPORT_BACK, STEPS.PASSPORT_ANNEX].includes(step)) {
            // User sent text instead of photo
            await ScreenManager.renderScreen(ctx, "📸 <b>Будь ласка, надішли саме фото документа.</b>\n\nЯкщо у тебе декілька фото, надсилай їх по одному. ✨");
        }
        else if (step === STEPS.IBAN) {
            const ibanVal = text.toUpperCase().replace(/\s+/g, '');
            if (!ibanVal.startsWith("UA") || ibanVal.length < 15) {
                await ScreenManager.renderScreen(ctx, "⚠️ <b>Це не схоже на IBAN.</b>\n\nВін має починатися на UA і містити 29 символів. Спробуй ще раз:");
                return;
            }
            ctx.session.candidateData.iban = ibanVal;
            ctx.session.candidateData.step = STEPS.INSTAGRAM;
            await ScreenManager.renderScreen(ctx, "📱 <b>Твій Instagram:</b>\n\nНапиши нік або посилання (наприклад, <code>@account</code>):", undefined, { pushToStack: true });
        }
        else if (step === STEPS.INSTAGRAM) {
            ctx.session.candidateData.instagram = text;
            ctx.session.candidateData.step = STEPS.FINAL;
            await finishOnboarding(ctx, candidate);
        }
    } catch (e) {
        logger.error({ err: e, step }, "Onboarding data save failed");
        await ScreenManager.renderScreen(ctx, "❌ <b>Сталася помилка.</b>\n\nСпробуй, будь ласка, ще раз або напиши в підтримку.");
    }
});

onboardingHandlers.on("message:photo", async (ctx, next) => {
    const step = ctx.session.candidateData?.step;
    if (!step || ![STEPS.PASSPORT_FRONT, STEPS.PASSPORT_BACK, STEPS.PASSPORT_ANNEX].includes(step)) return next();

    // SMI: Clean up user input immediately
    await ctx.deleteMessage().catch(() => { });

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const telegramId = ctx.from!.id;
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) return next();

    if (!ctx.session.candidateData.passportPhotoIds) {
        ctx.session.candidateData.passportPhotoIds = [];
    }
    ctx.session.candidateData.passportPhotoIds.push(photo!.file_id);

    try {
        if (step === STEPS.PASSPORT_FRONT) {
            ctx.session.candidateData.step = STEPS.PASSPORT_BACK;
            await ScreenManager.renderScreen(ctx, "✅ Отримали! Тепер надішли фото <b>зворотної сторони</b> (ID-картка), 2-гу сторінку паспорта або скріншот з застосунку <b>Дія</b>:", undefined, { pushToStack: true });
        } else if (step === STEPS.PASSPORT_BACK) {
            ctx.session.candidateData.step = STEPS.PASSPORT_ANNEX;
            await ScreenManager.renderScreen(ctx, "✅ Отримали! Тепер фото <b>прописки</b> (паперовий додаток до ID-картки, відповідна сторінка паспорта або скріншот з <b>Дії</b>):", undefined, { pushToStack: true });
        } else {
            ctx.session.candidateData.step = STEPS.IBAN;
            const ibanText = `✅ Всі фото отримали!\n\n` +
                `🏦 <b>Реквізити (IBAN).</b>\n\n` +
                `Надішли свій номер рахунку <b>IBAN (бажано Monobank)</b>. Він починається на UA...\n\n` +
                `<i>Ці дані необхідні виключно для автоматичного заповнення твого договору NDA.</i>`;
            await ScreenManager.renderScreen(ctx, ibanText, undefined, { pushToStack: true });
        }
    } catch (e) {
        logger.error({ err: e, step }, "Onboarding photo handling failed");
        await ScreenManager.renderScreen(ctx, "❌ <b>Не вдалося обробити фото.</b>\n\nСпробуй ще раз.");
    }
});

import { FunnelStep } from "@prisma/client";

async function finishOnboarding(ctx: MyContext, existingCandidate: any) {
    const candidateId = existingCandidate?.id;
    logger.info({ candidateId }, "🏁 Starting finishOnboarding...");

    try {
        const data = ctx.session.candidateData;
        if (!data) {
            throw new Error("Candidate data missing in session");
        }

        const bd = data.birthDate ? new Date(data.birthDate) : existingCandidate.birthDate;

        logger.debug({ candidateId }, "💾 Updating candidate in DB...");
        // DB Persistence: Save all accumulated data exactly once at the end.
        // We use await here to ensure DB is updated before showing next screen
        const updatedCandidate = await candidateRepository.update(candidateId, {
            fullName: data.fullName || existingCandidate.fullName,
            birthDate: bd,
            phone: data.phone || existingCandidate.phone,
            email: data.email || existingCandidate.email,
            iban: data.iban || existingCandidate.iban,
            instagram: data.instagram || existingCandidate.instagram,
            passportPhotoIds: data.passportPhotoIds ? data.passportPhotoIds.join(',') : existingCandidate.passportPhotoIds,
            status: 'AWAITING_FIRST_SHIFT',
            currentStep: FunnelStep.FIRST_SHIFT
        } as any);

        logger.debug({ candidateId }, "✅ DB Update done. Preparing final screen...");

        // Safe Job Offloading: Process heavy media & admin messages in background
        import("../modules/candidate/services/index.js").then(({ candidateService }) => {
            candidateService.processOnboardingFinish(ctx.api, updatedCandidate).catch(e => {
                logger.error({ err: e, candidateId }, "Failed in background processOnboardingFinish");
            });
        }).catch(e => {
            logger.error({ err: e, candidateId }, "Failed to import candidateService");
        });

        const { accessService } = await import("../services/access-service.js");
        const teamChannelLink = accessService.staticJoinLink || "https://t.me/+FuFRMGsvMktkNGFi";

        const text = `✨ <b>Майже готово!</b>\n\n` +
            `Твої дані успішно прийняті. Поки ми їх перевіряємо, залишився останній крок — обрати твої вихідні дні для складання графіка. 🗓️\n\n` +
            `📸 <b>Також:</b> Приєднуйся до нашої <a href="${teamChannelLink}">Бази знань</a>, якщо ти ще не там. ✨`;

        const kb = new InlineKeyboard()
            .text("🗓️ Обрати вихідні", "onb_to_prefs").row()
            .url("📖 База знань", teamChannelLink);

        // Final cleanup BEFORE screen is shown to avoid deleting the new screen
        await cleanupMessages(ctx).catch(() => { });

        // This is the point where user sees the change
        await ScreenManager.renderScreen(ctx, text, kb, { forceNew: true });

        logger.info({ candidateId }, "✅ finishOnboarding complete!");
    } catch (e) {
        logger.error({ err: e, candidateId }, "Critical failure in finishOnboarding");
        await ScreenManager.renderScreen(ctx, "❌ <b>Сталася помилка при завершенні.</b>\n\nЗв'яжись, будь ласка, з адміном.");
    }
}

onboardingHandlers.callbackQuery("onb_to_prefs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { startPreferencesFlow } = await import("./preferences-flow.js");
    await startPreferencesFlow(ctx);
});
