import type { MiddlewareFn } from "grammy";
import type { MyContext } from "../types/context.js";
import { AWS_RECRUITING_COMMANDS_ENABLED } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { AwsBusinessApiError, awsBusinessClient } from "../services/aws-business-client.js";
import { getRichMessagePlainText } from "../utils/rich-message.js";

/** API-контракт: `body` ограничен @MaxLength(4000), Telegram отдаёт до 4096. */
const MAX_BODY_LENGTH = 4000;

type MirrorAttachment = { fileId: string; kind: "PHOTO" | "VOICE" | "VIDEO" | "VIDEO_NOTE" };

/**
 * Вложение и человекочитаемая метка для тела сообщения.
 *
 * Метку формирует БОТ, а не веб: у `body` на той стороне стоит MinLength(1), и
 * медиа без подписи дало бы пустую строку и 400. Порядок веток совпадает с
 * getCandidateSupportPayload в handlers/support.ts (photo → video_note →
 * voice → video) — если там появится новый вид, добавлять надо в обоих местах.
 */
function extractAttachment(message: Record<string, any> | undefined): {
    attachment: MirrorAttachment | null;
    label: string;
} {
    const photo = message?.photo;
    // Последний элемент — максимальный размер.
    if (Array.isArray(photo) && photo.length > 0) {
        return { attachment: { fileId: photo[photo.length - 1].file_id, kind: "PHOTO" }, label: "📷 Фото" };
    }
    if (message?.video_note) {
        return { attachment: { fileId: message.video_note.file_id, kind: "VIDEO_NOTE" }, label: "⭕ Відеозаписка" };
    }
    if (message?.voice) {
        return { attachment: { fileId: message.voice.file_id, kind: "VOICE" }, label: "🎙 Голосове повідомлення" };
    }
    if (message?.video) {
        return { attachment: { fileId: message.video.file_id, kind: "VIDEO" }, label: "🎥 Відео" };
    }
    return { attachment: null, label: "" };
}

/**
 * Зеркалирование входящих сообщений кандидаток в тред рекрутёра в вебаппе
 * (фаза 3b, полный цикл найма).
 *
 * НЕ вмешивается в обработку: хук — fire-and-forget с .catch, next() зовётся
 * сразу, недоступный вебапп никогда не ломает собственные ответы бота
 * (support-флоу, анкеты, меню — всё работает как раньше). Гейтится тем же
 * AWS_RECRUITING_COMMANDS_ENABLED, что и весь контур команд.
 *
 * Пушатся только приватные сообщения (текст, медиа с подписью или без, rich-
 * message) людей, у которых есть запись Candidate в пред-найме (не HIRED) и
 * нет активного staff-профиля. 404 с кодом RECRUITING_CANDIDATE_NOT_FOUND —
 * молчаливый пропуск: кандидатки ещё нет в зеркале, это не ошибка.
 */
export const recruitingIncomingMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
    forwardCandidateMessage(ctx);
    await next();
};

function forwardCandidateMessage(ctx: MyContext): void {
    if (!AWS_RECRUITING_COMMANDS_ENABLED) return;
    if (ctx.chat?.type !== "private") return;
    if (!ctx.from || ctx.from.is_bot) return;
    // Активный сотрудник пишет боту как сотрудник — это не переписка
    // рекрутёр ↔ кандидатка, даже если Candidate-строка сохранилась.
    if (ctx.dbUser?.staffProfile?.isActive) return;

    const message = ctx.message as Record<string, any> | undefined;
    const { attachment, label } = extractAttachment(message);
    const richText = getRichMessagePlainText(message?.rich_message);
    const caption = message?.text || message?.caption || richText || "";
    const rawBody = label && caption ? `${label}: ${caption}` : label || caption;
    // Ни текста, ни медиа — зеркалить нечего.
    if (!rawBody) return;
    const body = rawBody.slice(0, MAX_BODY_LENGTH);

    const telegramId = ctx.from.id;
    const telegramMessageId = ctx.message?.message_id;
    const sentAtSeconds = ctx.message?.date;

    void (async () => {
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (!candidate || candidate.status === "HIRED") return;

        await awsBusinessClient.pushIncomingRecruitingMessage({
            telegramId: String(telegramId),
            body,
            ...(telegramMessageId === undefined ? {} : { telegramMessageId: String(telegramMessageId) }),
            ...(sentAtSeconds === undefined ? {} : { sentAt: new Date(sentAtSeconds * 1000).toISOString() }),
            ...(attachment === null ? {} : { attachment }),
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
