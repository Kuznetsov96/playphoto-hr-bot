import type { MiddlewareFn } from "grammy";
import type { MyContext } from "../types/context.js";
import { AWS_RECRUITING_COMMANDS_ENABLED } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { AwsBusinessApiError, awsBusinessClient } from "../services/aws-business-client.js";

/**
 * Зеркалирование входящих сообщений кандидаток в тред рекрутёра в вебаппе
 * (фаза 3b, полный цикл найма).
 *
 * НЕ вмешивается в обработку: хук — fire-and-forget с .catch, next() зовётся
 * сразу, недоступный вебапп никогда не ломает собственные ответы бота
 * (support-флоу, анкеты, меню — всё работает как раньше). Гейтится тем же
 * AWS_RECRUITING_COMMANDS_ENABLED, что и весь контур команд.
 *
 * Пушатся только приватные ТЕКСТОВЫЕ сообщения людей, у которых есть запись
 * Candidate в пред-найме (не HIRED) и нет активного staff-профиля. 404 с
 * кодом RECRUITING_CANDIDATE_NOT_FOUND — молчаливый пропуск: кандидатки ещё
 * нет в зеркале, это не ошибка.
 */
export const recruitingIncomingMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
    forwardCandidateMessage(ctx);
    await next();
};

/**
 * Является ли текст перепиской с рекрутёром.
 *
 * Мидлварь стоит в цепочке РАНЬШЕ перехвата /start (core/bot.ts) и раньше
 * обработчиков анкеты, поэтому отсечь служебный ввод можно только здесь —
 * ниже по цепочке сообщение уже не наше. Отсекаем два класса:
 *  - команды: это обращение к боту, а не к человеку;
 *  - любой ввод во время анкеты: имя, дата рождения, город, «+» — ответы на
 *    вопросы бота, и рекрутёру они приходили как отдельные сообщения.
 */
export function shouldMirrorCandidateText(text: string, step: string | undefined): boolean {
    if (text.startsWith("/")) return false;
    if (step?.startsWith("screening_")) return false;
    return true;
}

function forwardCandidateMessage(ctx: MyContext): void {
    if (!AWS_RECRUITING_COMMANDS_ENABLED) return;
    if (ctx.chat?.type !== "private") return;
    const text = ctx.message?.text;
    if (!text || !ctx.from || ctx.from.is_bot) return;
    // Активный сотрудник пишет боту как сотрудник — это не переписка
    // рекрутёр ↔ кандидатка, даже если Candidate-строка сохранилась.
    if (ctx.dbUser?.staffProfile?.isActive) return;
    if (!shouldMirrorCandidateText(text, ctx.session?.step)) return;

    const telegramId = ctx.from.id;
    const telegramMessageId = ctx.message?.message_id;
    const sentAtSeconds = ctx.message?.date;

    void (async () => {
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (!candidate || candidate.status === "HIRED") return;

        await awsBusinessClient.pushIncomingRecruitingMessage({
            telegramId: String(telegramId),
            body: text,
            ...(telegramMessageId === undefined ? {} : { telegramMessageId: String(telegramMessageId) }),
            ...(sentAtSeconds === undefined ? {} : { sentAt: new Date(sentAtSeconds * 1000).toISOString() }),
        });
    })().catch((error) => {
        if (error instanceof AwsBusinessApiError && error.code === "RECRUITING_CANDIDATE_NOT_FOUND") {
            return;
        }
        logBusinessEvent({
            event: "bot.recruiting_messages.incoming_push_failed",
            level: "warn",
            actorType: "system",
            actorRole: "system",
            telegramId,
            result: "failed",
            reasonCode: "INCOMING_PUSH_FAILED",
            module: "recruiting-incoming",
            operation: "forwardCandidateMessage",
            error,
        });
    });
}
