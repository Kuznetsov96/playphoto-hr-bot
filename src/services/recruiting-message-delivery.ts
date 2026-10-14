import { InlineKeyboard, type Api } from "grammy";
import { TRAINING_MINIAPP_BASE_URL } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { INVALID_WEB_APP_BUTTON, awsBusinessClient } from "./aws-business-client.js";
import { describeCommandFailure } from "./recruiting-failure-reason.js";
import { buildMiniAppUrl } from "./training-review.js";

/** Контрактный максимум одного тика — очередь короткая, тик минутный. */
const PENDING_LIMIT = 50;

/**
 * Заблокировавшая бота кандидатка — самый частый «сбой» доставки. Причина в
 * треде рекрутёра должна называть его прямо, а не выглядеть сетевой ошибкой:
 * рекрутёр после этого пишет кандидатке сам, с личного аккаунта владельца.
 */
function describeDeliveryFailure(error: unknown): string {
    const carrier = error as { error_code?: unknown; description?: unknown };
    const description = typeof carrier?.description === "string" ? carrier.description : "";
    if (carrier?.error_code === 403 || description.includes("bot was blocked")) {
        return `BOT_BLOCKED_BY_CANDIDATE: ${description || "the candidate blocked the bot"}`.slice(0, 450);
    }
    return describeCommandFailure(error);
}

/**
 * Доставка исходящих сообщений рекрутёра (фаза 3b). Веб пишет PENDING в
 * outbox, этот проход шлёт каждое через общий Api живущего бота и отвечает
 * sent/failed. Обычное сообщение — простой текст без клавиатуры; если веб
 * приложил webAppButton — тот же текст с одной кнопкой Mini App обучения.
 * Живёт внутри тика диспетчера команд — та же Redis-лиза, тот же флаг
 * AWS_RECRUITING_COMMANDS_ENABLED.
 *
 * Никогда не бросает: сбой одного сообщения — его собственный failed-ack,
 * сбой списка — нулевой проход с логом; очередь догонит следующий тик.
 */
export async function deliverPendingRecruitingMessages(api: Api): Promise<{ sent: number; failed: number }> {
    let pending;
    try {
        pending = await awsBusinessClient.listPendingRecruitingMessages(PENDING_LIMIT);
    } catch (error) {
        logBusinessEvent({
            event: "bot.recruiting_messages.pending_fetch_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "PENDING_FETCH_FAILED",
            module: "recruiting-message-delivery",
            operation: "deliverPendingRecruitingMessages",
            error,
        });
        return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const message of pending.items) {
        try {
            if (message.webAppButton === INVALID_WEB_APP_BUTTON) {
                throw new Error("MESSAGE_NOT_SENT:invalid_web_app_button");
            }
            const options = message.webAppButton
                ? {
                      reply_markup: new InlineKeyboard().webApp(
                          message.webAppButton.text,
                          buildMiniAppUrl(TRAINING_MINIAPP_BASE_URL, message.webAppButton.path),
                      ),
                  }
                : undefined;
            const delivered = options
                ? await api.sendMessage(Number(message.telegramId), message.body, options)
                : await api.sendMessage(Number(message.telegramId), message.body);
            sent++;
            await ack(message.publicId, () => awsBusinessClient.ackRecruitingMessageSent(
                message.publicId,
                delivered?.message_id === undefined ? undefined : String(delivered.message_id),
            ));
        } catch (error) {
            failed++;
            const reason = describeDeliveryFailure(error);
            logBusinessEvent({
                event: "bot.recruiting_messages.delivery_failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                telegramId: message.telegramId,
                result: "failed",
                reasonCode: reason.slice(0, 80),
                module: "recruiting-message-delivery",
                operation: "deliverPendingRecruitingMessages",
                safeContext: { messagePublicId: message.publicId },
                error,
            });
            await ack(message.publicId, () => awsBusinessClient.ackRecruitingMessageFailed(message.publicId, reason));
        }
    }

    if (pending.items.length > 0) {
        logBusinessEvent({
            event: "bot.recruiting_messages.iteration_completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "recruiting-message-delivery",
            operation: "deliverPendingRecruitingMessages",
            safeContext: { pendingCount: pending.items.length, sent, failed },
        });
    }
    return { sent, failed };
}

/** Потерянный ack не валит проход: вебапп предложит сообщение снова. */
async function ack(publicId: string, send: () => Promise<unknown>): Promise<void> {
    try {
        await send();
    } catch (error) {
        logBusinessEvent({
            event: "bot.recruiting_messages.ack_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "ACK_REQUEST_FAILED",
            module: "recruiting-message-delivery",
            operation: "ack",
            safeContext: { messagePublicId: publicId },
            error,
        });
    }
}
