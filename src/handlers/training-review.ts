import type { Composer, NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { readCallbackPayload } from "../utils/signed-callback.js";
import { getAdminRoleByTelegramId } from "../config/roles.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { ATTACHMENT_LABELS } from "../constants/attachment-labels.js";
import { AwsBusinessApiError, awsBusinessClient } from "../services/aws-business-client.js";
import {
    TRAINING_CB,
    TRAINING_REJECT_REASONS,
    cardKey,
    rejectKeyboard,
    reviewKeyboard,
    retryKeyboard,
    splitIdAndNumber,
} from "../services/training-review-card.js";
import { redis } from "../core/redis.js";
import { isBotBlocked } from "../utils/bot-blocked.js";
import logger from "../core/logger.js";

const FEEDBACK_TTL_SECONDS = 7 * 24 * 3600;
const feedbackKey = (chatId: number, messageId: number) => `training:feedback:${chatId}:${messageId}`;
const PATTERN = new RegExp(`^cb:(${Object.values(TRAINING_CB).join("|")}):`);
const EMPTY_MARKUP = { reply_markup: { inline_keyboard: [] } };

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** Решение по кандидатке принимает только владелец: SUPER_ADMIN или CO_FOUNDER. */
function isOwner(id: number): boolean {
    const role = getAdminRoleByTelegramId(BigInt(id));
    return role === "SUPER_ADMIN" || role === "CO_FOUNDER";
}

function maskToItems(mask: number): number[] {
    return [0, 1, 2, 3, 4, 5].filter((i) => mask & (1 << i)).map((i) => i + 1);
}

async function decide(
    ctx: MyContext,
    reviewPublicId: string,
    decision: "PASSED" | "RETRY" | "REJECTED",
    failedItems: number[],
    reasonCode: string | null,
): Promise<void> {
    let result: Awaited<ReturnType<typeof awsBusinessClient.postTrainingReviewDecision>>;
    try {
        result = await awsBusinessClient.postTrainingReviewDecision(reviewPublicId, {
            decision,
            failedItems,
            reasonCode,
            reviewerTelegramId: String(ctx.from!.id),
        });
    } catch (error) {
        if (error instanceof AwsBusinessApiError && error.code === "REVIEW_ALREADY_DECIDED") {
            await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["training-already-decided"], show_alert: true });
            await ctx.editMessageReplyMarkup(EMPTY_MARKUP).catch(() => {});
            return;
        }
        // Кнопка не должна крутиться: отвечаем, оставляем кнопки живыми для повтора и логируем.
        logger.error(
            { operation: "training-review-decide", decision, errorName: errorName(error) },
            "Training review decision failed",
        );
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["training-decision-failed"], show_alert: true });
        return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup(EMPTY_MARKUP).catch(() => {});
    const summary =
        decision === "PASSED"
            ? ADMIN_TEXTS["training-decision-passed"](result.candidateName)
            : decision === "RETRY"
              ? ADMIN_TEXTS["training-decision-retry"]
              : ADMIN_TEXTS["training-decision-rejected"](ADMIN_TEXTS["training-reject-reason"](reasonCode ?? "OTHER"));
    if (decision === "REJECTED") {
        await ctx.reply(summary);
        return;
    }
    const prompt = await ctx.reply(`${summary}\n\n${ADMIN_TEXTS["training-feedback-prompt"](result.candidateName)}`);
    await redis.set(
        feedbackKey(ctx.chat!.id, prompt.message_id),
        JSON.stringify({
            reviewPublicId,
            candidateTelegramId: result.candidateTelegramId,
            candidateName: result.candidateName,
        }),
        "EX",
        FEEDBACK_TTL_SECONDS,
    );
}

/** Чек-лист карточки из Redis; null — запись истекла или не читается. */
function readCardChecklist(raw: string | null): string[] | null {
    if (!raw) return null;
    try {
        const { checklist } = JSON.parse(raw) as { checklist?: unknown };
        return Array.isArray(checklist) && checklist.every((item) => typeof item === "string") ? checklist : null;
    } catch {
        return null;
    }
}

async function answerCardExpired(ctx: MyContext): Promise<void> {
    await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["training-card-expired"], show_alert: true });
}

async function redrawRetry(ctx: MyContext, reviewPublicId: string, mask: number): Promise<void> {
    const checklist = readCardChecklist(await redis.get(cardKey(reviewPublicId)));
    if (!checklist) return answerCardExpired(ctx);
    await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["training-retry-pick"] });
    await ctx.editMessageReplyMarkup({ reply_markup: retryKeyboard(reviewPublicId, mask, checklist) }).catch(() => {});
}

export async function handleTrainingCallback(ctx: MyContext): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    if (!ctx.from || !isOwner(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["training-not-allowed"], show_alert: true });
        return;
    }
    const read = (code: string) => readCallbackPayload(data, { code });

    const passId = read(TRAINING_CB.pass);
    if (passId) return decide(ctx, passId, "PASSED", [], null);

    const retryId = read(TRAINING_CB.retry);
    if (retryId) return redrawRetry(ctx, retryId, 0);

    const toggle = read(TRAINING_CB.toggle);
    const toggled = toggle ? splitIdAndNumber(toggle) : null;
    if (toggled) return redrawRetry(ctx, toggled.reviewPublicId, toggled.n);

    const send = read(TRAINING_CB.sendRetry);
    const sent = send ? splitIdAndNumber(send) : null;
    if (sent) return decide(ctx, sent.reviewPublicId, "RETRY", maskToItems(sent.n), null);

    const rejectId = read(TRAINING_CB.reject);
    if (rejectId) {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: rejectKeyboard(rejectId) }).catch(() => {});
        return;
    }

    const backId = read(TRAINING_CB.back);
    if (backId) {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: reviewKeyboard(backId) }).catch(() => {});
        return;
    }

    const reason = read(TRAINING_CB.rejectReason);
    const parsedReason = reason ? splitIdAndNumber(reason) : null;
    const code = parsedReason ? TRAINING_REJECT_REASONS[parsedReason.n] : undefined;
    if (parsedReason && code) return decide(ctx, parsedReason.reviewPublicId, "REJECTED", [], code);

    // Подпись не сошлась (секрет сменился, карточка старая) или payload битый —
    // решение по такой карточке принимается в вебаппе.
    await answerCardExpired(ctx);
}

export async function handleTrainingFeedback(ctx: MyContext, next: NextFunction): Promise<void> {
    const message = ctx.message;
    const replyTo = message?.reply_to_message;
    if (!message || !replyTo || !ctx.from || ctx.chat?.type !== "private" || !isOwner(ctx.from.id)) return next();
    const raw = await redis.get(feedbackKey(ctx.chat.id, replyTo.message_id));
    if (!raw) return next();
    const { reviewPublicId, candidateTelegramId } = JSON.parse(raw) as {
        reviewPublicId: string;
        candidateTelegramId: string;
    };

    const attachment = message.voice
        ? { fileId: message.voice.file_id, kind: "VOICE" as const }
        : message.video_note
          ? { fileId: message.video_note.file_id, kind: "VIDEO_NOTE" as const }
          : null;
    const body = message.text ?? (attachment ? ATTACHMENT_LABELS[attachment.kind] : null);
    if (!body) return next(); // стикер, фото и прочее — не совет

    let copied: { message_id: number };
    try {
        copied = await ctx.api.copyMessage(Number(candidateTelegramId), ctx.chat.id, message.message_id);
    } catch (error) {
        // isBotBlocked: заблокировала бота, удалила аккаунт или чата нет — один ответ на все три.
        if (isBotBlocked(error)) {
            await ctx.reply(ADMIN_TEXTS["training-feedback-blocked"]);
            return;
        }
        throw error;
    }
    try {
        await awsBusinessClient.postTrainingReviewFeedback(reviewPublicId, {
            reviewerTelegramId: String(ctx.from.id),
            // Id копии в чате кандидатки — то сообщение, которое она видит.
            telegramMessageId: String(copied.message_id),
            body,
            attachment,
        });
    } catch (error) {
        // Совет уже у кандидатки; повторный ответ владельца продублировал бы его. Только лог.
        logger.error(
            { operation: "training-review-feedback", errorName: errorName(error) },
            "Training review feedback was relayed but not recorded",
        );
    }
    await ctx.reply(ADMIN_TEXTS["training-feedback-sent"]);
}

export function registerTrainingReviewHandlers(composer: Composer<MyContext>): void {
    composer.callbackQuery(PATTERN, handleTrainingCallback);
    composer.on("message", handleTrainingFeedback);
}
