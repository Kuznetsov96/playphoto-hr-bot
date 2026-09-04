import type { MiddlewareFn } from "grammy";
import type { MyContext } from "../types/context.js";
import { AWS_RECRUITING_COMMANDS_ENABLED } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { AwsBusinessApiError, awsBusinessClient } from "../services/aws-business-client.js";
import { getRichMessagePlainText } from "../utils/rich-message.js";

/** API-контракт: `body` ограничен @MaxLength(4000), Telegram отдаёт до 4096. */
const MAX_BODY_LENGTH = 4000;

/**
 * Шаги, на которых входящее ФОТО — не переписка, а документ или уже
 * показанный на другом экране снимок. Зеркалировать их в тред рекрутёра
 * нельзя: паспорт — это не корреспонденция, и onboarding-handler.ts уже
 * применяет свою приватность-меру (await ctx.deleteMessage() сразу после
 * получения) специально для того, чтобы файл нигде не задержался кроме
 * файлового хранилища Telegram под id кандидатки. Зеркало обходило эту меру
 * стороной — пушило file_id ДО того, как ctx.deleteMessage() в
 * onboarding-handler.ts успевал сработать — и документ всё равно попадал в
 * веб-карточку кандидатки, доступную роли RECRUITER.
 *
 * ВАЖНО ПРО ДОСТИЖИМОСТЬ (проверено 04.09.2026): в текущей воронке эти шаги
 * НЕ достигаются. Путь кандидатки в боте заканчивается решением после
 * собеседования, а единственное место, выставляющее ONB_PASSPORT_*, — это
 * dev-команда /set_step (handlers/commands.ts:661) за флагом
 * ALLOW_DEV_COMMANDS (по умолчанию false) и только для админов/кофаундеров.
 * То есть список ниже — не заплатка действующей утечки, а предохранитель:
 * онбординг в боте живой код, и если его когда-нибудь снова подключат к
 * воронке, зеркало не должно молча начать выкладывать паспорта в веб-карточку.
 * Стоит он дёшево (сравнение строки), а восстанавливать его задним числом
 * пришлось бы уже после утечки.
 *
 * Значения из ctx.session.candidateData.step (onboarding-handler.ts, STEPS):
 * см. src/handlers/onboarding-handler.ts:266-268.
 */
const DOCUMENT_COLLECTION_CANDIDATE_STEPS: readonly string[] = [
    "ONB_PASSPORT_FRONT", // паспорт/ID-картка, лицьова сторона
    "ONB_PASSPORT_BACK",  // паспорт/ID-картка, зворотна сторона
    "ONB_PASSPORT_ANNEX", // прописка (додаток до ID-картки) або скрін з Дії
];

/**
 * Значение из ctx.session.step (modules/candidate/handlers/index.ts) — экран
 * скрининга, где кандидатка присылает фото внешности/татуировки. Оно уже
 * показывается рекрутёру на экране REVIEW по дизайну; зеркало не должно
 * создавать для него ВТОРОЙ долгоживущий указатель (S3-кеш при первом
 * просмотре) в отдельном треде.
 * См. src/modules/candidate/handlers/index.ts:447-452.
 */
const DOCUMENT_COLLECTION_SESSION_STEPS: readonly string[] = [
    "screening_appearance", // фото зовнішності/татуювання на скринінгу
];

/**
 * true, если сейчас нельзя зеркалить фото — кандидатка на шаге сбора
 * документов или на экране, чей снимок уже показан рекрутёру по дизайну.
 * Не текстовые сообщения этим шагом никогда не гейтятся — риск только у фото.
 */
function isOnDocumentCollectionStep(ctx: MyContext): boolean {
    const candidateStep = ctx.session?.candidateData?.step;
    if (candidateStep && DOCUMENT_COLLECTION_CANDIDATE_STEPS.includes(candidateStep)) return true;

    const sessionStep = ctx.session?.step;
    if (sessionStep && DOCUMENT_COLLECTION_SESSION_STEPS.includes(sessionStep)) return true;

    return false;
}

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
    if (!ctx.from || ctx.from.is_bot) return;
    // Активный сотрудник пишет боту как сотрудник — это не переписка
    // рекрутёр ↔ кандидатка, даже если Candidate-строка сохранилась.
    if (ctx.dbUser?.staffProfile?.isActive) return;

    const message = ctx.message as Record<string, any> | undefined;
    // Приватность: фото на шаге сбора документов (паспорт/ID/прописка) или
    // на экране скрининга с татуировкой — не зеркалим вообще. См.
    // DOCUMENT_COLLECTION_*_STEPS выше и isOnDocumentCollectionStep.
    if (Array.isArray(message?.photo) && message.photo.length > 0 && isOnDocumentCollectionStep(ctx)) return;

    const { attachment, label } = extractAttachment(message);
    const richText = getRichMessagePlainText(message?.rich_message);
    const caption = message?.text || message?.caption || richText || "";
    const rawBody = label && caption ? `${label}: ${caption}` : label || caption;
    // Ни текста, ни медиа — зеркалить нечего.
    if (!rawBody) return;

    // Служебный ввод — не переписка (команды, ответы анкеты). Проверяется по
    // ТЕКСТУ, а не по вложению: подпись под фото — такое же сообщение человеку,
    // и медиа с ней зеркалить надо. Поэтому фильтр стоит здесь, после сборки
    // caption, а не в начале функции: до слияния он читал ctx.message.text,
    // которого у медиа с подписью просто нет.
    if (!shouldMirrorCandidateText(caption, ctx.session?.step)) return;

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
