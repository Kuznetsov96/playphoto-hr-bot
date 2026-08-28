import type { Api } from "grammy";
import { logBusinessEvent } from "../core/log-events.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { awsBusinessClient, type RecruitingBroadcast } from "./aws-business-client.js";
import { hrService } from "./hr-service.js";
import { describeCommandFailure } from "./recruiting-failure-reason.js";

/**
 * Больше 500 получателей — почти наверняка ошибка (опечатка в городе или
 * рассылка «на всех»): отбиваем громко, не отправив ни одного сообщения.
 * Вебапп режет выборку на тех же 500 — гвард здесь на случай рассинхрона.
 */
const MAX_RECIPIENTS = 500;

/** Пауза между отправками — щадим лимиты Telegram (~30 msg/s на бота). */
const SEND_DELAY_MS = 50;

const delay = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Исполнение рассылок по пулу города. Живёт внутри тика диспетчера команд —
 * та же Redis-лиза, тот же флаг AWS_RECRUITING_COMMANDS_ENABLED.
 *
 * Получателей присылает вебапп готовым списком telegramId — ровно ту выборку,
 * что показала число на кнопке подтверждения; бот НЕ выбирает сам. kind
 * решает содержание: INVITE — стандартное запрошення на выбор слота через
 * hrService.inviteCandidate (проверки пола/возраста и отметка приглашения
 * включены), MESSAGE — произвольный текст.
 *
 * Никогда не бросает: развал одной рассылки — её собственный failed-ack.
 */
export async function runPendingRecruitingBroadcasts(
    api: Api,
    options: { delayMs?: number } = {},
): Promise<{ processed: number }> {
    const delayMs = options.delayMs ?? SEND_DELAY_MS;

    let pending;
    try {
        pending = await awsBusinessClient.listPendingRecruitingBroadcasts();
    } catch (error) {
        logBusinessEvent({
            event: "bot.recruiting_broadcasts.pending_fetch_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "PENDING_FETCH_FAILED",
            module: "recruiting-broadcast-delivery",
            operation: "runPendingRecruitingBroadcasts",
            error,
        });
        return { processed: 0 };
    }

    let processed = 0;
    for (const broadcast of pending.items) {
        await runOne(api, broadcast, delayMs);
        processed++;
    }
    return { processed };
}

async function runOne(api: Api, broadcast: RecruitingBroadcast, delayMs: number): Promise<void> {
    try {
        const refusal = validate(broadcast);
        if (refusal) {
            logBusinessEvent({
                event: "bot.recruiting_broadcasts.refused",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: refusal.slice(0, 80),
                module: "recruiting-broadcast-delivery",
                operation: "runOne",
                safeContext: { broadcastPublicId: broadcast.publicId, recipients: broadcast.recipients.length },
            });
            await ack(broadcast.publicId, () =>
                awsBusinessClient.ackRecruitingBroadcastFailed(broadcast.publicId, refusal));
            return;
        }

        let sent = 0;
        let failed = 0;
        for (const telegramId of broadcast.recipients) {
            const delivered = broadcast.kind === "INVITE"
                ? await deliverInvite(api, telegramId)
                : await deliverMessage(api, telegramId, broadcast.body as string);
            if (delivered) sent++;
            else failed++;
            await delay(delayMs);
        }

        logBusinessEvent({
            event: "bot.recruiting_broadcasts.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "recruiting-broadcast-delivery",
            operation: "runOne",
            safeContext: {
                broadcastPublicId: broadcast.publicId,
                city: broadcast.city,
                kind: broadcast.kind,
                sent,
                failed,
            },
        });
        await ack(broadcast.publicId, () =>
            awsBusinessClient.ackRecruitingBroadcastDone(broadcast.publicId, { sent, failed }));
    } catch (error) {
        const reason = describeCommandFailure(error);
        logBusinessEvent({
            event: "bot.recruiting_broadcasts.run_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: reason.slice(0, 80),
            module: "recruiting-broadcast-delivery",
            operation: "runOne",
            safeContext: { broadcastPublicId: broadcast.publicId },
            error,
        });
        await ack(broadcast.publicId, () =>
            awsBusinessClient.ackRecruitingBroadcastFailed(broadcast.publicId, reason));
    }
}

/** Контрактные отказы целой рассылки — до первой отправки. */
function validate(broadcast: RecruitingBroadcast): string | null {
    if (broadcast.recipients.length > MAX_RECIPIENTS) return "BROADCAST_TOO_LARGE";
    if (broadcast.kind === "INVITE") return null;
    if (broadcast.kind === "MESSAGE") {
        // body отсутствовать не должен (вебапп валидирует на входе), но слать
        // «null» людям из-за рассинхрона контракта нельзя.
        return broadcast.body === null || broadcast.body.length === 0 ? "BROADCAST_BODY_MISSING" : null;
    }
    // Более свежий вебапп прислал незнакомый вид — громкий failed вместо
    // тихой отправки не того содержания.
    return `UNKNOWN_BROADCAST_KIND:${broadcast.kind}`;
}

/**
 * Запрошення — тем же путём, что кнопка «Invite» и команда INVITE_TO_INTERVIEW:
 * проверки пола/возраста, приглашение с кнопками записи, отметка
 * interviewInvitedAt. Отказ (неподходящий кандидат, блокировка) — failed++.
 */
async function deliverInvite(api: Api, telegramId: string): Promise<boolean> {
    try {
        const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
        if (!candidate) return false;
        const result = await hrService.inviteCandidate(api, candidate.id);
        return result.ok;
    } catch {
        return false;
    }
}

async function deliverMessage(api: Api, telegramId: string, body: string): Promise<boolean> {
    try {
        await api.sendMessage(Number(telegramId), body);
        return true;
    } catch {
        // Заблокировавшие бота и прочие недоставки — честный failed++,
        // рассылка продолжается для остальных.
        return false;
    }
}

/** Потерянный ack не валит проход: вебапп предложит рассылку снова. */
async function ack(publicId: string, send: () => Promise<unknown>): Promise<void> {
    try {
        await send();
    } catch (error) {
        logBusinessEvent({
            event: "bot.recruiting_broadcasts.ack_failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "ACK_REQUEST_FAILED",
            module: "recruiting-broadcast-delivery",
            operation: "ack",
            safeContext: { broadcastPublicId: publicId },
            error,
        });
    }
}
