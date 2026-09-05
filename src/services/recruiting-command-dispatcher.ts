import type { Api } from "grammy";
import { CandidateStatus } from "@prisma/client";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { awsBusinessClient, type RecruitingCommand } from "./aws-business-client.js";
import { hrService } from "./hr-service.js";
import { teamRegistrationService } from "./team-registration-service.js";
import { describeCommandFailure } from "./recruiting-failure-reason.js";
import { deliverPendingRecruitingMessages } from "./recruiting-message-delivery.js";
import { runPendingRecruitingBroadcasts } from "./recruiting-broadcast-delivery.js";

export { describeCommandFailure } from "./recruiting-failure-reason.js";

const LEASE_KEY = "worker:recruiting-command-dispatcher:lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;

/**
 * Меньше контрактных 50/200: команды применяются строго последовательно (каждая
 * шлёт сообщения в Telegram), и короткий тик раз в минуту важнее большого куска.
 */
const PENDING_LIMIT = 20;

/**
 * Статусы ручного owner-контура: со стадий TRAINING/STAGING/DOCS зеркала
 * владелец общается с кандидаткой ЛИЧНО со своего аккаунта, поэтому REJECT
 * здесь немой — только перевод воронки, без сообщения от бота.
 */
const MANUAL_CONTOUR_STATUSES: ReadonlySet<CandidateStatus> = new Set([
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
]);

/**
 * Минимальные ЛЕГАЛЬНЫЕ пути по funnel-guard для немых owner-команд. Путь —
 * это цепочка статусов до цели; уже достигнутые шаги applySilentStatusPath
 * пропускает. Для статуса вне ожидаемых путь начинается с первого шага цепочки
 * и guard сам отбивает переход своим reasonCode — он уедет в failed-ack.
 */
function trainingPassedPath(_current: CandidateStatus): CandidateStatus[] {
    // Из любого статуса стадии TRAINING гард пускает напрямую (owner-контур).
    return [CandidateStatus.TRAINING_COMPLETED];
}

function startStagingPath(current: CandidateStatus): CandidateStatus[] {
    if (current === CandidateStatus.STAGING_ACTIVE) return [CandidateStatus.STAGING_ACTIVE];
    if (current === CandidateStatus.STAGING_SETUP || current === CandidateStatus.OFFLINE_STAGING) {
        return [CandidateStatus.STAGING_ACTIVE];
    }
    if (current === CandidateStatus.TRAINING_COMPLETED) {
        return [CandidateStatus.STAGING_SETUP, CandidateStatus.STAGING_ACTIVE];
    }
    // Стадия TRAINING зеркала: через TRAINING_COMPLETED (целевой конвейер
    // без NDA/KNOWLEDGE_TEST).
    return [CandidateStatus.TRAINING_COMPLETED, CandidateStatus.STAGING_SETUP, CandidateStatus.STAGING_ACTIVE];
}

function stagingPassedPath(current: CandidateStatus): CandidateStatus[] {
    // STAGING_SETUP не пускается в READY_FOR_HIRE напрямую — через ACTIVE.
    if (current === CandidateStatus.STAGING_SETUP) {
        return [CandidateStatus.STAGING_ACTIVE, CandidateStatus.READY_FOR_HIRE];
    }
    return [CandidateStatus.READY_FOR_HIRE];
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

            // Фаза 3b: исходящие сообщения рекрутёра и рассылки по пулу
            // города живут в том же тике под той же лизой. Оба прохода
            // спроектированы «никогда не бросать», но и неожиданный сбой
            // одного не должен срывать другой.
            await deliverPendingRecruitingMessages(api).catch(error => logBusinessEvent({
                event: "bot.recruiting_messages.iteration_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "recruiting-command-dispatcher",
                operation: "runOnce",
                error,
            }));
            await runPendingRecruitingBroadcasts(api).catch(error => logBusinessEvent({
                event: "bot.recruiting_broadcasts.iteration_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "recruiting-command-dispatcher",
                operation: "runOnce",
                error,
            }));
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
                if (!result.ok) {
                    // Префикс говорит рекрутёру, дошло сообщение или нет.
                    // state_write_failed — единственная причина, при которой
                    // кандидат приглашение УЖЕ получил: врать про NOT_SENT
                    // здесь значит отправить рекрутёра искать не тот сбой.
                    const prefix = result.reason === "state_write_failed"
                        ? "INVITE_SENT_STATE_NOT_SAVED"
                        : "INVITE_NOT_SENT";
                    throw new Error(`${prefix}:${result.reason ?? "unknown"}`);
                }
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
                // Owner-контур (навчання/стажування/документи): владелец уже
                // сообщил кандидатке лично — воронка двигается НЕМО, без
                // сообщения от бота. На тату-проверке — тату-отказ с его
                // сообщением (APPEARANCE), до интервью — прежний кнопочный
                // путь rejectCandidate с сообщением GENERAL.
                if (MANUAL_CONTOUR_STATUSES.has(candidate.status)) {
                    await candidateRepository.update(candidate.id, {
                        status: CandidateStatus.REJECTED,
                        hrDecision: "REJECTED",
                    });
                    return;
                }
                const reason = candidate.status === CandidateStatus.MANUAL_REVIEW ? "APPEARANCE" : "GENERAL";
                const ok = await hrService.rejectCandidate(api, candidate.id, reason);
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            case "APPROVE_REVIEW": {
                // Кнопка «✅ Approve Tattoo»: возврат в SCREENING существующим
                // тату-флоу бота — с его сообщением кандидатке.
                const ok = await hrService.approveTattoo(api, candidate.id);
                if (!ok) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            // ---- Немые owner-команды полного цикла (фаза 3b). Владелец
            // общается с кандидаткой лично, поэтому здесь НЕТ ни сообщений
            // кандидатке, ни уведомлений менторам/стейджингу — только
            // последовательные легальные шаги воронки через репозиторий
            // (каждый шаг проверяет funnel-guard и зеркалится в вебапп). ----
            case "MARK_TRAINING_PASSED": {
                await this.applySilentStatusPath(candidate.id, candidate.status,
                    trainingPassedPath(candidate.status));
                return;
            }
            case "START_STAGING": {
                // Без sendStagingNotifications — владелец договаривается сам.
                await this.applySilentStatusPath(candidate.id, candidate.status,
                    startStagingPath(candidate.status));
                return;
            }
            case "MARK_STAGING_PASSED": {
                // Без промпта о сборе документов — владелец собирает их лично
                // (явное решение владельца от 28.08.2026).
                await this.applySilentStatusPath(candidate.id, candidate.status,
                    stagingPassedPath(candidate.status));
                return;
            }
            case "CONFIRM_HIRE": {
                // Тот же пост-найм, что и кнопка admin_hire_final, МИНУС вся
                // переписка с кандидаткой. Сначала Employee в вебаппе
                // (upsert, идемпотентно) — если локация не смаплена, команда
                // падает ДО перевода статуса и честно ретраится; затем
                // confirmFinalSchedule: HIRED + accessService.syncUserAccess
                // + таймлайн (сообщений кандидатке он не шлёт).
                await teamRegistrationService.registerNewHire({
                    fullName: candidate.fullName || "—",
                    phone: candidate.phone || "—",
                    email: candidate.email || "—",
                    telegramId: String(candidate.user.telegramId),
                    username: candidate.user.username || "—",
                    instagram: candidate.instagram || "—",
                    iban: candidate.iban || "—",
                    city: candidate.city || "—",
                    locationName: candidate.location?.name || "—",
                    ...(candidate.location?.canonicalCode ? { locationCode: candidate.location.canonicalCode } : {}),
                    birthDate: candidate.birthDate,
                });
                const hired = await hrService.confirmFinalSchedule(candidate.id);
                if (!hired) throw new Error("CANDIDATE_NOT_FOUND_IN_BOT");
                return;
            }
            default:
                // Более свежий вебапп прислал незнакомый вид команды: громкий
                // failed вместо тихого пропуска — после пятой попытки рекрутёр
                // увидит FAILED с этим кодом в карточке.
                throw new Error(`UNKNOWN_COMMAND_KIND:${command.kind}`);
        }
    }

    /**
     * Последовательно проводит кандидатку по цепочке статусов. Каждый шаг —
     * обычный candidateRepository.update: funnel-guard валидирует переход
     * (невозможный путь даёт failed-ack с его reasonCode), зеркало пушится,
     * доступ к каналам синкается фоном. Сообщений НЕ шлётся нигде.
     */
    private async applySilentStatusPath(
        candidateId: string,
        currentStatus: CandidateStatus,
        path: CandidateStatus[],
    ): Promise<void> {
        for (const status of path) {
            // Пропуск уже достигнутого статуса делает команду идемпотентной
            // при ретрае после потерянного ack.
            if (status === currentStatus) continue;
            await candidateRepository.update(candidateId, { status });
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
