import type { Api } from "grammy";
import { CandidateStatus } from "@prisma/client";
import { logBusinessEvent } from "../core/log-events.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { awsBusinessClient, type RecruitingBroadcast } from "./aws-business-client.js";
import { describeCommandFailure } from "./recruiting-failure-reason.js";

/**
 * Больше 500 получателей — почти наверняка ошибка (опечатка в городе или
 * рассылка «на всех»): отбиваем громко, не отправив ни одного сообщения.
 */
const MAX_RECIPIENTS = 500;

/** Пауза между отправками — щадим лимиты Telegram (~30 msg/s на бота). */
const SEND_DELAY_MS = 50;

/**
 * Обратный маппинг стадий вебаппа в статусы бота — ЗЕРКАЛО таблицы
 * `apps/api/src/recruiting/stage-mapping.ts` вебаппа для стадий рассылок.
 * Веб оценивает получателей по зеркальным строкам со стадиями
 * SCREENING/WAITLIST, значит бот обязан взять ровно те статусы, которые в эти
 * стадии зеркалятся (MANUAL_REVIEW → SCREENING; оба вейтлиста → WAITLIST),
 * иначе счётчики бота разойдутся с оценкой рекрутёра.
 */
const BOT_STATUSES_BY_WEB_STAGE: Readonly<Record<string, readonly CandidateStatus[]>> = {
    SCREENING: [CandidateStatus.SCREENING, CandidateStatus.MANUAL_REVIEW],
    WAITLIST: [CandidateStatus.WAITLIST, CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST_MENTOR],
};

/** Неизвестная стадия из более свежего вебаппа даёт пустой вклад, а не падение. */
export function botStatusesForStages(stages: readonly string[]): CandidateStatus[] {
    return stages.flatMap((stage) => [...(BOT_STATUSES_BY_WEB_STAGE[stage] ?? [])]);
}

const delay = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Исполнение рассылок по пулу города (фаза 3b). Живёт внутри тика диспетчера
 * команд — та же Redis-лиза, тот же флаг AWS_RECRUITING_COMMANDS_ENABLED.
 * Выборка получателей: статусы зеркальных стадий + город, ТОТ ЖЕ city,
 * который зеркало шлёт в снимке кандидатки (candidate.city как есть) — веб и
 * бот выбирают одних и тех же людей.
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
        await runOne(api, broadcast, pending.stages, delayMs);
        processed++;
    }
    return { processed };
}

async function runOne(api: Api, broadcast: RecruitingBroadcast, stages: string[], delayMs: number): Promise<void> {
    try {
        const statuses = botStatusesForStages(stages);
        const recipients = await candidateRepository.findByStatusWithUser(statuses, { city: broadcast.city });

        if (recipients.length > MAX_RECIPIENTS) {
            logBusinessEvent({
                event: "bot.recruiting_broadcasts.refused",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "BROADCAST_TOO_LARGE",
                module: "recruiting-broadcast-delivery",
                operation: "runOne",
                safeContext: { broadcastPublicId: broadcast.publicId, recipients: recipients.length },
            });
            await ack(broadcast.publicId, () =>
                awsBusinessClient.ackRecruitingBroadcastFailed(broadcast.publicId, "BROADCAST_TOO_LARGE"));
            return;
        }

        let sent = 0;
        let failed = 0;
        for (const recipient of recipients) {
            try {
                await api.sendMessage(Number(recipient.user.telegramId), broadcast.body);
                sent++;
            } catch {
                // Заблокировавшие бота и прочие недоставки — честный failed++,
                // рассылка продолжается для остальных.
                failed++;
            }
            await delay(delayMs);
        }

        logBusinessEvent({
            event: "bot.recruiting_broadcasts.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "recruiting-broadcast-delivery",
            operation: "runOne",
            safeContext: { broadcastPublicId: broadcast.publicId, city: broadcast.city, sent, failed },
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
