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

// Determines the first onboarding step that hasn't been completed yet
export function getFirstMissingStep(candidate: any): string {
    if (!candidate.fullName) return STEPS.FULL_NAME;
    if (!candidate.birthDate) return STEPS.BIRTH_DATE;
    if (!candidate.phone) return STEPS.PHONE;
    if (!candidate.email) return STEPS.EMAIL;
    const photoIds = candidate.passportPhotoIds ? candidate.passportPhotoIds.split(',').filter(Boolean) : [];
    if (photoIds.length < 1) return STEPS.PASSPORT_FRONT;
    if (photoIds.length < 2) return STEPS.PASSPORT_BACK;
    if (photoIds.length < 3) return STEPS.PASSPORT_ANNEX;
    if (!candidate.iban) return STEPS.IBAN;
    if (!candidate.instagram) return STEPS.INSTAGRAM;
    return STEPS.FINAL;
}

// Returns the missing field labels for smart reminders
export function getMissingFieldLabels(candidate: any): string[] {
    const missing: string[] = [];
    if (!candidate.fullName) missing.push("ПІБ");
    if (!candidate.birthDate) missing.push("дату народження");
    if (!candidate.phone) missing.push("телефон");
    if (!candidate.email) missing.push("email");
    const photoIds = candidate.passportPhotoIds ? candidate.passportPhotoIds.split(',').filter(Boolean) : [];
    if (photoIds.length < 3) missing.push("фото документів");
    if (!candidate.iban) missing.push("IBAN");
    if (!candidate.instagram) missing.push("Instagram");
    return missing;
}

function getStepPrompt(step: string): string {
    switch (step) {
        case STEPS.FULL_NAME: return "Напиши, будь ласка, своє повне Прізвище, Ім'я та По Батькові (як у паспорті):";
        case STEPS.BIRTH_DATE: return "🎈 <b>Коли твій день народження?</b>\n\nНапиши у форматі ДД.ММ.РРРР (наприклад, 15.05.2000):";
        case STEPS.PHONE: return "📱 <b>Твій номер телефону:</b>\n\nНапиши у форматі +380...";
        case STEPS.EMAIL: return "📧 <b>Твій Email:</b>\n\nВін потрібен для офіційного листування та NDA:";
        case STEPS.PASSPORT_FRONT: return "📸 <b>Тепер документи.</b>\n\nНадішли, будь ласка, фото <b>лицьової сторони</b> паспорта (або ID-картки). Також можна використовувати скріншот з застосунку <b>Дія</b>. 📱";
        case STEPS.PASSPORT_BACK: return "📸 Надішли фото <b>зворотної сторони</b> (ID-картка), 2-гу сторінку паспорта або скріншот з застосунку <b>Дія</b>:";
        case STEPS.PASSPORT_ANNEX: return "📸 Тепер фото <b>прописки</b> (паперовий додаток до ID-картки, відповідна сторінка паспорта або скріншот з <b>Дії</b>):";
        case STEPS.IBAN: return `🏦 <b>Реквізити (IBAN).</b>\n\nНадішли свій номер рахунку <b>IBAN (бажано Monobank)</b>. Він починається на UA...\n\n<i>Ці дані необхідні виключно для автоматичного заповнення твого договору NDA.</i>`;
        case STEPS.INSTAGRAM: return "📱 <b>Твій Instagram:</b>\n\nНапиши нік або посилання (наприклад, <code>@account</code>):";
        default: return "";
    }
}

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

    // Resume from first missing field instead of starting over
    const resumeStep = getFirstMissingStep(candidate);

    if (resumeStep === STEPS.FINAL) {
        // All data already collected — go straight to finish
        ctx.session.candidateData = { step: STEPS.FINAL, passportPhotoIds: [] };
        await finishOnboarding(ctx, candidate);
        return;
    }

    ctx.session.candidateData = {
        step: resumeStep,
        passportPhotoIds: candidate.passportPhotoIds ? candidate.passportPhotoIds.split(',').filter(Boolean) : []
    };

    // If resuming from step 1, show welcome text; otherwise show the step prompt directly
    if (resumeStep === STEPS.FULL_NAME) {
        const startText = `🔒 <b>Твої дані під захистом.</b>\n\n` +
            `Ми використовуємо сучасні стандарти безпеки, щоб твої документи залишалися суворо конфіденційними. Вони використовуються виключно для підготовки договору та початку нашої співпраці.\n\n` +
            `Напиши, будь ласка, своє повне Прізвище, Ім'я та По Батькові (як у паспорті):`;
        await ScreenManager.renderScreen(ctx, startText, undefined, { pushToStack: true });
    } else if (resumeStep === STEPS.BIRTH_DATE && candidate.birthDate) {
        // Birth date exists but step says it's missing — show confirmation
        const bdStr = candidate.birthDate.toLocaleDateString('uk-UA');
        ctx.session.candidateData.step = STEPS.BIRTH_DATE;
        await ScreenManager.renderScreen(ctx, `🎈 <b>Твоя дата народження:</b> ${bdStr}\n\nВсе правильно?`, "onb-confirm-bd", { pushToStack: true });
    } else {
        await ScreenManager.renderScreen(ctx, getStepPrompt(resumeStep), undefined, { pushToStack: true });
    }
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
            await candidateRepository.update(candidate.id, { fullName: val.data } as any);

            const bd = candidate.birthDate;
            if (bd) {
                const bdStr = bd.toLocaleDateString('uk-UA');
                await ScreenManager.renderScreen(ctx, `🎈 <b>Твоя дата народження:</b> ${bdStr}\n\nВсе правильно?`, "onb-confirm-bd", { pushToStack: true });
            } else {
                ctx.session.candidateData.step = STEPS.BIRTH_DATE;
                await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.BIRTH_DATE), undefined, { pushToStack: true });
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
            await candidateRepository.update(candidate.id, { birthDate: date } as any);

            ctx.session.candidateData.step = STEPS.PHONE;
            await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.PHONE), undefined, { pushToStack: true });
        }
        else if (step === STEPS.PHONE) {
            const sanitized = text.replace(/\s+/g, '').replace(/-/g, '').replace(/\(/g, '').replace(/\)/g, '');
            const val = CandidateSchema.shape.phone.safeParse(sanitized);
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>\n\nПриклад: +380931234567`);
                return;
            }
            await candidateRepository.update(candidate.id, { phone: val.data } as any);

            ctx.session.candidateData.step = STEPS.EMAIL;
            await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.EMAIL), undefined, { pushToStack: true });
        }
        else if (step === STEPS.EMAIL) {
            const val = CandidateSchema.shape.email.safeParse(text.toLowerCase());
            if (!val.success) {
                await ScreenManager.renderScreen(ctx, `⚠️ <b>${val.error.issues[0]?.message}</b>`);
                return;
            }
            await candidateRepository.update(candidate.id, { email: val.data } as any);

            ctx.session.candidateData.step = STEPS.PASSPORT_FRONT;
            await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.PASSPORT_FRONT), undefined, { pushToStack: true });
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
            await candidateRepository.update(candidate.id, { iban: ibanVal } as any);

            ctx.session.candidateData.step = STEPS.INSTAGRAM;
            await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.INSTAGRAM), undefined, { pushToStack: true });
        }
        else if (step === STEPS.INSTAGRAM) {
            await candidateRepository.update(candidate.id, { instagram: text } as any);

            ctx.session.candidateData.step = STEPS.FINAL;
            // Re-fetch candidate with all saved data
            const updatedCandidate = await candidateRepository.findByTelegramId(Number(telegramId));
            await finishOnboarding(ctx, updatedCandidate!);
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

    // Save photo to DB immediately
    const updatedPhotoIds = ctx.session.candidateData.passportPhotoIds.join(',');
    await candidateRepository.update(candidate.id, { passportPhotoIds: updatedPhotoIds } as any);

    try {
        if (step === STEPS.PASSPORT_FRONT) {
            ctx.session.candidateData.step = STEPS.PASSPORT_BACK;
            await ScreenManager.renderScreen(ctx, "✅ Отримали! Тепер надішли фото <b>зворотної сторони</b> (ID-картка), 2-гу сторінку паспорта або скріншот з застосунку <b>Дія</b>:", undefined, { pushToStack: true });
        } else if (step === STEPS.PASSPORT_BACK) {
            ctx.session.candidateData.step = STEPS.PASSPORT_ANNEX;
            await ScreenManager.renderScreen(ctx, "✅ Отримали! Тепер фото <b>прописки</b> (паперовий додаток до ID-картки, відповідна сторінка паспорта або скріншот з <b>Дії</b>):", undefined, { pushToStack: true });
        } else {
            ctx.session.candidateData.step = STEPS.IBAN;
            await ScreenManager.renderScreen(ctx, getStepPrompt(STEPS.IBAN), undefined, { pushToStack: true });
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
        // All fields already saved incrementally — just update status
        const updatedCandidate = await candidateRepository.update(candidateId, {
            status: 'AWAITING_FIRST_SHIFT',
            currentStep: FunnelStep.FIRST_SHIFT
        } as any);

        logger.debug({ candidateId }, "✅ Status updated. Preparing final screen...");

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
