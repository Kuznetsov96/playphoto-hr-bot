import type { Api } from "grammy";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { awsBusinessClient, type RecruitingCommand } from "./aws-business-client.js";
import { hrService } from "./hr-service.js";

const LEASE_KEY = "worker:recruiting-command-dispatcher:lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;

/**
 * Меньше контрактных 50/200: команды применяются строго последовательно (каждая
 * шлёт сообщения в Telegram), и короткий тик раз в минуту важнее большого куска.
 */
const PENDING_LIMIT = 20;

/**
 * Запас до контрактных 500: ack-клиент дорежет по контракту сам, но причина,
 * которую увидит рекрутёр, не должна обрываться на полуслове.
 */
const MAX_ERROR_LENGTH = 450;

/**
 * Сводит любую ошибку применения к короткой строке для карточки рекрутёра.
 * Код воронки (`reasonCode` у InvalidCandidateTransitionError, `code` у
 * AwsBusinessApiError) идёт первым — это то, по чему диагностируют; текст —
 * следом, для человека.
 */
export function describeCommandFailure(error: unknown): string {
    if (error instanceof Error) {
        const carrier = error as { reasonCode?: unknown; code?: unknown };
        const code = typeof carrier.reasonCode === "string"
            ? carrier.reasonCode
            : typeof carrier.code === "string" ? carrier.code : null;
        const text = code && code !== error.message ? `${code}: ${error.message}` : (code ?? error.message);
        return text.slice(0, MAX_ERROR_LENGTH);
    }
    return String(error).slice(0, MAX_ERROR_LENGTH);
}

/**
 * Диспетчер команд рекрутёра (фаза 3a). Вебапп принимает решение и кладёт его
 * в outbox; этот цикл забирает pending и применяет каждую команду СВОЕЙ
 * воронкой — ровно теми вызовами hr-service, которые дергают кнопки HR-меню,
 * со всеми их побочными эффектами: сообщение кандидату, шестичасовая задержка
 * отказа, уведомления менторам, funnel-guard. Подтверждение новой стадии
 * уезжает в вебапп обычным mirror-пушем; здесь только applied/failed-ack.
 *
 * Гонки между инстансами бота гасятся Redis-лизой (SET NX + heartbeat), как у
 * schedule-notification-dispatcher: процесс-локальный boolean, как у
 * access-revocation, аудит пометил дефектом — он не защищает от второго
 * контейнера.
 */
export class RecruitingCommandDispatcher {
    private iterationInProgress = false;

    async runOnce(api: Api): Promise<void> {
        if (this.iterationInProgress) {
            logBusinessEvent({
                event: "bot.recruiting_commands.iteration_skipped",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "skipped",
                reasonCode: "LOCAL_ITERATION_IN_PROGRESS",
                module: "recruiting-command-dispatcher",
                operation: "runOnce",
            });
            return;
        }

        this.iterationInProgress = true;
        const leaseToken = `${process.pid}:${Date.now()}:${Math.random()}`;
        let heartbeat: NodeJS.Timeout | undefined;
        try {
            const acquired = await redis.set(LEASE_KEY, leaseToken, "PX", LEASE_TTL_MS, "NX");
            if (acquired !== "OK") {
                logBusinessEvent({
                    event: "bot.recruiting_commands.iteration_skipped",
                    level: "debug",
                    actorType: "system",
                    actorRole: "system",
                    result: "skipped",
                    reasonCode: "LEASE_HELD_BY_ANOTHER_INSTANCE",
                    module: "recruiting-command-dispatcher",
                    operation: "runOnce",
                });
                return;
            }

            heartbeat = setInterval(() => {
                redis.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
                    1,
                    LEASE_KEY,
                    leaseToken,
                    String(LEASE_TTL_MS)
                ).catch(error => logBusinessEvent({
                    event: "bot.recruiting_commands.lease_renew_failed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    module: "recruiting-command-dispatcher",
                    operation: "renewLease",
                    error,
                }));
            }, LEASE_HEARTBEAT_MS);

            const pending = await awsBusinessClient.listPendingRecruitingCommands(PENDING_LIMIT);

            // Строго последовательно и с поштучной изоляцией: одна кривая
            // команда стоит один failed-ack, а не всю очередь за собой.
            let applied = 0;
            let failed = 0;
            for (const command of pending.items) {
                const ok = await this.applyOne(api, command);
                if (ok) applied++; else failed++;
            }

            logBusinessEvent({
                event: "bot.recruiting_commands.iteration_completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "recruiting-command-dispatcher",
                operation: "runOnce",
                safeContext: { pendingCount: pending.items.length, applied, failed },
            });
        } catch (error) {
            logBusinessEvent({
                event: "bot.recruiting_commands.iteration_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "PENDING_FETCH_FAILED",
                module: "recruiting-command-dispatcher",
                operation: "runOnce",
                error,
            });
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            await redis.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                LEASE_KEY,
                leaseToken
            ).catch(error => logBusinessEvent({
                event: "bot.recruiting_commands.lease_release_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "recruiting-command-dispatcher",
                operation: "releaseLease",
                error,
            }));
            this.iterationInProgress = false;
        }
    }

    /** Применяет одну команду и отправляет ack. Никогда не бросает. */
    private async applyOne(api: Api, command: RecruitingCommand): Promise<boolean> {
        try {
            await this.execute(api, command);
        } catch (error) {
            const reason = describeCommandFailure(error);
            logBusinessEvent({
                event: "bot.recruiting_commands.apply_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                telegramId: command.candidate.telegramId,
                result: "failed",
                reasonCode: reason.slice(0, 80),
                module: "recruiting-command-dispatcher",
                operation: "applyOne",
                safeContext: { commandPublicId: command.publicId, kind: command.kind, attempts: command.attempts },
                error,
            });
            await this.ack(command.publicId, () =>
                awsBusinessClient.ackRecruitingCommandFailed(command.publicId, reason)
            );
            return false;
        }

        logBusinessEvent({
            event: "bot.recruiting_commands.applied",
            actorType: "system",
            actorRole: "system",
            telegramId: command.candidate.telegramId,
            result: "success",
            module: "recruiting-command-dispatcher",
            operation: "applyOne",
            safeContext: { commandPublicId: command.publicId, kind: command.kind },
        });
        await this.ack(command.publicId, () =>
            awsBusinessClient.ackRecruitingCommandApplied(command.publicId)
        );
        return true;
    }

    /**
     * Маппинг kind → существующее HR-действие бота. Гарантия фазы 3a: команда
     * из вебаппа делает ровно то же, что и палец рекрутёра на кнопке в боте.
     */
    private async execute(api: Api, command: RecruitingCommand): Promise<void> {
        const candidate = await candidateRepository.findByTelegramId(Number(command.candidate.telegramId));
        if (!candidate) {
            // Кандидат в зеркале есть, в боте нет — контрактный код, по нему
            // рекрутёр в карточке видит, что применить решение было не к кому.
            throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
        }

        switch (command.kind) {
            case "INVITE_TO_INTERVIEW": {
                // Та же логика, что кнопка «Invite»: проверки пола/возраста,
                // приглашение с кнопками записи, отметка interviewInvitedAt.
                const result = await hrService.inviteCandidate(api, candidate.id);
                if (!result.ok) throw new Error(`INVITE_NOT_SENT:${result.reason ?? "unknown"}`);
                return;
            }
            case "ACCEPT_AFTER_INTERVIEW": {
                // Кнопка «✅ Accept Offer»: решение с шестичасовой задержкой
                // доставки — оффер кандидатке отправит воркер, как и всегда.
                const ok = await hrService.makeDecision(api, candidate.id, "ACCEPTED", "webapp-recruiter");
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            case "REJECT_AFTER_INTERVIEW": {
                // Кнопка «❌ Reject» после интервью — та же отложенная доставка.
                const ok = await hrService.makeDecision(api, candidate.id, "REJECTED", "webapp-recruiter");
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            case "MARK_NO_SHOW": {
                // Кнопка «🚫 No-show»: статус + вежливое сообщение кандидатке.
                // Сообщение — best-effort, как и в меню: недоставка не отменяет
                // сам факт неявки.
                const ok = await hrService.markNoShow(candidate.id);
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                try {
                    const { trackUserMessage } = await import("../utils/cleanup.js");
                    const tid = Number(candidate.user.telegramId);
                    const msg = await api.sendMessage(tid, STAFF_TEXTS["hr-rejection-noshow"]);
                    if (msg) await trackUserMessage(tid, msg.message_id);
                } catch {
                    // Кандидатка могла заблокировать бота — команда всё равно применена.
                }
                return;
            }
            case "REJECT": {
                // Отказ до интервью — тот же путь, что кнопочный, с кодом GENERAL.
                const ok = await hrService.rejectCandidate(api, candidate.id, "GENERAL");
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            default:
                // Более свежий вебапп прислал незнакомый вид команды: громкий
                // failed вместо тихого пропуска — после пятой попытки рекрутёр
                // увидит FAILED с этим кодом в карточке.
                throw new Error(`UNKNOWN_COMMAND_KIND:${command.kind}`);
        }
    }

    /** Потерянный ack не валит проход: вебапп просто предложит команду снова. */
    private async ack(publicId: string, send: () => Promise<unknown>): Promise<void> {
        try {
            await send();
        } catch (error) {
            logBusinessEvent({
                event: "bot.recruiting_commands.ack_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "ACK_REQUEST_FAILED",
                module: "recruiting-command-dispatcher",
                operation: "ack",
                safeContext: { commandPublicId: publicId },
                error,
            });
        }
    }
}

export const recruitingCommandDispatcher = new RecruitingCommandDispatcher();
