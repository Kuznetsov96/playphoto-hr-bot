import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { TRAINING_QUIZ } from "../config/quiz.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { ScreenManager } from "../utils/screen-manager.js";
import { cleanupMessages } from "../utils/cleanup.js";
import { createKyivDate } from "../utils/bot-utils.js";
import logger from "../core/logger.js";

export const quizHandlers = new Composer<MyContext>();

quizHandlers.callbackQuery("start_quiz", async (ctx) => {
    await ctx.answerCallbackQuery();
    await cleanupMessages(ctx); // Clear old clutter before starting
    await startQuiz(ctx);
});

quizHandlers.callbackQuery("start_staging_selection", async (ctx) => {
    await ctx.answerCallbackQuery();
    const telegramId = ctx.from!.id;
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) return;

    // Guard: only allow date selection for candidates still in setup phase
    if (candidate.status !== CandidateStatus.STAGING_SETUP && candidate.status !== CandidateStatus.KNOWLEDGE_TEST) {
        return;
    }

    const text = `📸 <b>Обери зручний день для стажування</b>\n\n` +
        `Нагадаємо, воно триває 2 години (зазвичай 15:00–17:00). Обери дату, коли тобі буде зручно завітати на локацію: ✨`;

    const kb = generateStagingDatePicker();
    await ScreenManager.renderScreen(ctx, text, kb);
});

/**
 * Starts the quiz for a candidate
 */
export async function startQuiz(ctx: MyContext) {
    if (!ctx.session.candidateData) ctx.session.candidateData = {};

    // Preparation Card (Apple Style: Set expectations)
    const { accessService } = await import("../services/access-service.js");
    const joinLink = accessService.staticJoinLink;

    const text = `🧠 <b>Залишився останній крок — перевірка знань</b>\n\n` +
        `Цей тест допоможе нам переконатися, що ти готова до роботи. Більшість відповідей можна знайти в нашій <a href="${joinLink}">Базі знань</a>. ✨\n\n` +
        `⏳ <b>Деталі:</b>\n` +
        `• 53 запитання\n` +
        `• ~15 хвилин часу\n` +
        `• Потрібно 70% правильних відповідей\n\n` +
        `Переконайся, що тебе ніхто не відволікає. Готова розпочати? 👇`;

    const kb = new InlineKeyboard().text("🚀 Почати тест", "quiz_start_actual");
    await ScreenManager.renderScreen(ctx, text, kb);
}

quizHandlers.callbackQuery("quiz_start_actual", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.candidateData.step = 'QUIZ';

    // Use ALL 53 questions
    const selected = [...TRAINING_QUIZ];

    // Initialize quiz state in session
    (ctx.session as any).quizState = {
        currentQuestionIndex: 0,
        score: 0,
        answers: [],
        selectedQuestions: selected,
        wrongQuestionIds: [] // Track wrong answers for smart retry
    };

    await sendQuestion(ctx);
});

async function sendQuestion(ctx: MyContext) {
    const quizState = (ctx.session as any).quizState;
    if (!quizState) return;

    const questions = quizState.selectedQuestions;
    const question = questions[quizState.currentQuestionIndex];

    if (!question) {
        return await finishQuiz(ctx);
    }

    const kb = new InlineKeyboard();
    let optionsText = "";

    question.options.forEach((option: string, index: number) => {
        const num = index + 1;
        optionsText += `<b>${num}.</b> ${option}\n`;
        kb.text(`${num}`, `quiz_ans_${index}`);
    });

    const text = `📝 <b>Питання ${quizState.currentQuestionIndex + 1} з ${questions.length}</b>\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `<b>${question.text}</b>\n\n` +
        `${optionsText}\n` +
        `<i>Обери номер правильної відповіді:</i>`;

    await ScreenManager.renderScreen(ctx, text, kb);
}

quizHandlers.callbackQuery(/^quiz_ans_(\d+)$/, async (ctx) => {
    const quizState = (ctx.session as any).quizState;
    if (!quizState) return ctx.answerCallbackQuery("Сесія тесту завершена.");

    const answerIndex = parseInt(ctx.match![1]!);
    const question = quizState.selectedQuestions[quizState.currentQuestionIndex];
    if (!question) return ctx.answerCallbackQuery("Питання не знайдено.");

    // Record answer
    const isCorrect = answerIndex === question.correctIndex;
    if (isCorrect) {
        quizState.score += 1;
    } else {
        quizState.wrongQuestionIds.push(question.id);
    }

    quizState.answers.push({
        questionId: question.id,
        answerIndex,
        isCorrect
    });

    // Move to next
    quizState.currentQuestionIndex++;
    await ctx.answerCallbackQuery(isCorrect ? "✅ Правильно!" : "❌ Не зовсім...");
    await sendQuestion(ctx);
});

async function finishQuiz(ctx: MyContext) {
    const quizState = (ctx.session as any).quizState;
    const totalScore = quizState.score;
    const questionsCount = quizState.selectedQuestions.length;

    const threshold = Math.ceil(TRAINING_QUIZ.length * 0.7);
    const passed = totalScore >= threshold;

    const telegramId = ctx.from!.id;
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));

    if (!candidate) return;

    // Save results to DB
    const updateData = {
        quizScore: totalScore,
        quizAnswers: JSON.stringify(quizState.answers),
        testPassed: passed,
        ...(passed ? {
            status: CandidateStatus.STAGING_SETUP,
            currentStep: FunnelStep.FIRST_SHIFT,
            notificationSent: false
        } : {})
    };

    await candidateRepository.update(candidate.id, updateData as any);

    if (passed) {
        // Mentor notification
        if (totalScore >= 50) {
            const { MENTOR_IDS } = await import("../config.js");
            if (MENTOR_IDS.length > 0) {
                const mentorMsg = `🌟 <b>У нас з'явився талант!</b>\n\n` +
                    `Кандидатка <b>${candidate.fullName}</b> склала тест на <b>${totalScore}/${questionsCount} балів</b>! 🎯\n\n` +
                    `Вона вже обирає дату стажування. Очікуй! ✨`;
                await ctx.api.sendMessage(MENTOR_IDS[0]!, mentorMsg, { parse_mode: "HTML" }).catch(() => { });
            }
        }

        ctx.session.candidateData.step = 'SELECT_STAGING_DATES';
        const successText = CANDIDATE_TEXTS["staging-quiz-success"](totalScore, questionsCount);
        const kb = generateStagingDatePicker();
        await ScreenManager.renderScreen(ctx, successText, kb);
    } else {
        const failText = `✨ <b>Трішки не вистачило</b>\n\n` +
            `Твій результат: <b>${totalScore} балів</b>. Для проходження потрібно мінімум ${threshold}.\n\n` +
            `Але не хвилюйся! Давай ще раз пройдемося по тих питаннях, де були помилки, щоб закріпити матеріал. 💪🌸`;

        const kb = new InlineKeyboard().text("🔄 Спробувати ще раз", "quiz_retry_wrong");
        await ScreenManager.renderScreen(ctx, failText, kb);
    }
}

function generateStagingDatePicker() {
    const kb = new InlineKeyboard();
    const today = new Date();
    const weekdays = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    for (let i = 1; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const dayName = weekdays[d.getDay()];
        const dateStr = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}`;

        kb.text(`${dayName}, ${dateStr}`, `staging_date_${dateStr}`).row();
    }

    kb.text("Інші дати", "staging_no_date").row();
    return kb;
}

quizHandlers.callbackQuery("quiz_retry_wrong", async (ctx) => {
    const quizState = (ctx.session as any).quizState;
    if (!quizState || !quizState.wrongQuestionIds || quizState.wrongQuestionIds.length === 0) return ctx.answerCallbackQuery("Помилок не знайдено!");

    const retryQuestions = TRAINING_QUIZ.filter(q => quizState.wrongQuestionIds.includes(q.id));

    (ctx.session as any).quizState = {
        currentQuestionIndex: 0,
        score: quizState.score,
        answers: quizState.answers,
        selectedQuestions: retryQuestions,
        wrongQuestionIds: []
    };

    await ctx.answerCallbackQuery("Спробуймо ще раз! 💪");
    await sendQuestion(ctx);
});

quizHandlers.callbackQuery("staging_no_date", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["staging-no-date-available"]);

    // Notify HR
    try {
        const { HR_IDS } = await import("../config.js");
        if (HR_IDS && HR_IDS.length > 0) {
            const telegramId = ctx.from!.id;
            const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
            const name = candidate?.fullName || ctx.from?.first_name || "Candidate";
            const username = ctx.from?.username ? `@${ctx.from.username}` : "No username";

            const alertMsg = `📅 <b>INBOX: Staging date needed!</b>\n\n` +
                `👤 Candidate: <b>${name}</b>\n\n` +
                `<i>She passed the test but didn't find a convenient staging date. Please contact her!</i>`;

            for (const hrId of HR_IDS) {
                try {
                    await ctx.api.sendMessage(hrId, alertMsg, { parse_mode: "HTML" });
                } catch (e) {
                    logger.error({ err: e, hrId }, "Failed to send staging_no_date alert to HR");
                }
            }
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to process HR notification for staging_no_date");
    }

    delete (ctx.session as any).quizState;
});

quizHandlers.callbackQuery(/^staging_date_(.+)$/, async (ctx) => {
    const date = ctx.match![1]!;
    await ctx.answerCallbackQuery();

    try {
        const telegramId = ctx.from!.id;
        const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
        if (candidate) {
            // Guard: only allow date change for candidates in setup phase
            if (candidate.status !== CandidateStatus.STAGING_SETUP && candidate.status !== CandidateStatus.KNOWLEDGE_TEST) {
                return;
            }

            const [d, m] = date.split('.').map(Number);
            const currentYear = new Date().getFullYear();
            const shiftDate = createKyivDate(currentYear, m! - 1, d!, 12, 0);

            await candidateRepository.update(candidate.id, {
                firstShiftDate: shiftDate,
                firstShiftTime: candidate.firstShiftTime || "15:00-17:00",
                status: CandidateStatus.STAGING_SETUP,
                currentStep: FunnelStep.FIRST_SHIFT,
                notificationSent: false
            } as any);

            // Notify main admin about new staging date selection
            try {
                const { ADMIN_IDS } = await import("../config.js");
                if (ADMIN_IDS && ADMIN_IDS.length > 0 && ADMIN_IDS[0]) {
                    const adminMsg = `📅 <b>Staging date selected</b>\n\n👤 ${candidate.fullName}\n🏙️ ${candidate.city || '—'}\n📅 ${date}\n\nReview in Staging Setup.`;
                    await ctx.api.sendMessage(ADMIN_IDS[0], adminMsg, { parse_mode: "HTML" }).catch(() => { });
                }
            } catch (e) { logger.error({ err: e }, "Failed to notify admin about staging date"); }
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to save staging date");
    }

    // Cleanup old quiz messages BEFORE showing confirmation, so it stays visible
    await cleanupMessages(ctx);
    await ScreenManager.renderScreen(ctx, CANDIDATE_TEXTS["staging-date-confirmed"](date), CANDIDATE_TEXTS["staging-date-confirmed-kb"] as any);
    delete (ctx.session as any).quizState;
});
