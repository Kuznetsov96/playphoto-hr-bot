import type { Api } from "grammy";
import logger from "../core/logger.js";
import { ANNOUNCEMENTS_COMMANDS_ENABLED } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
import { broadcastActionRepository } from "../repositories/broadcast-action-repository.js";
import { nextAllowedPingTime } from "../utils/quiet-hours.js";
import { remindBroadcast } from "./pinger.js";
import { enqueueAnnouncementSyncSafe } from "./announcement-sync.js";
import { isBotBlocked } from "../utils/bot-blocked.js";
import { awsBusinessClient, type AnnouncementAttachment, type AnnouncementCommand } from "./aws-business-client.js";
import { broadcastService } from "./broadcast.js";
import type { BroadcastMediaItem } from "../types/context.js";

const LEASE_KEY = "worker:announcement-command-dispatcher:lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const PENDING_LIMIT = 20;
export const ANNOUNCEMENT_COMMAND_POLL_MS = 15 * 1000;

/** Автор команды вебаппа: у такой рассылки нет Telegram-инициатора. */
const WEBAPP_INITIATOR_ID = 0;

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === "P2002";
const errorText = (error: unknown): string => {
    const e = error as { description?: string; message?: string } | null;
    return e?.description || e?.message || String(error);
};

/** Короткий код отказа тестовой отправки для карточки в вебаппе. */
export function describeTestFailure(error: unknown): string {
    if ((error as { status?: number } | null)?.status === 404) return "ATTACHMENT_UNAVAILABLE";
    if (/can't parse entities/iu.test(errorText(error))) return "HTML_REJECTED";
    if (isBotBlocked(error)) return "BOT_BLOCKED";
    if (/blocked/iu.test(errorText(error))) return "BOT_BLOCKED";
    return "TEST_FAILED";
}

/**
 * Команды рассылок из вебаппа (фаза 2A): `SEND` создаёт Broadcast с publicId
 * вебаппа и ставит его в обычную очередь рассылок, `TEST` шлёт одно сообщение
 * владельцу. Та же форма, что у RecruitingCommandDispatcher: Redis-лиз против
 * второго инстанса и `iterationInProgress` против наложения тиков.
 *
 * Идемпотентность: вебапп выдаёт команду at-least-once, publicId — ключ.
 * Broadcast уже есть → только accepted. Гонку двух параллельных создателей
 * гасит уникальный индекс publicId (P2002 = «уже есть»), а повторную постановку
 * в очередь — jobId `broadcast-<id>`.
 */
export class AnnouncementCommandDispatcher {
    private iterationInProgress = false;

    async runOnce(api: Api): Promise<void> {
        if (this.iterationInProgress) return;
        this.iterationInProgress = true;
        const leaseToken = `${process.pid}:${Date.now()}:${Math.random()}`;
        let heartbeat: NodeJS.Timeout | undefined;
        try {
            const acquired = await redis.set(LEASE_KEY, leaseToken, "PX", LEASE_TTL_MS, "NX");
            if (acquired !== "OK") return;

            heartbeat = setInterval(() => {
                redis.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
                    1, LEASE_KEY, leaseToken, String(LEASE_TTL_MS),
                ).catch(error => logBusinessEvent({
                    event: "bot.announcement_commands.lease_renew_failed",
                    level: "error", actorType: "system", actorRole: "system", result: "failed",
                    module: "announcement-commands", operation: "renewLease", error,
                }));
            }, LEASE_HEARTBEAT_MS);

            const pending = await awsBusinessClient.listPendingAnnouncementCommands(PENDING_LIMIT);
            let accepted = 0;
            let failed = 0;
            for (const command of pending.items) {
                if (await this.applyOne(api, command)) accepted++; else failed++;
            }
            if (pending.items.length > 0) {
                logBusinessEvent({
                    event: "bot.announcement_commands.iteration_completed",
                    actorType: "system", actorRole: "system", result: "success",
                    module: "announcement-commands", operation: "runOnce",
                    safeContext: { pendingCount: pending.items.length, accepted, failed },
                });
            }
        } catch (error) {
            logBusinessEvent({
                event: "bot.announcement_commands.iteration_failed",
                level: "error", actorType: "system", actorRole: "system", result: "failed",
                reasonCode: "PENDING_FETCH_FAILED",
                module: "announcement-commands", operation: "runOnce", error,
            });
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            await redis.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1, LEASE_KEY, leaseToken,
            ).catch(error => logBusinessEvent({
                event: "bot.announcement_commands.lease_release_failed",
                level: "error", actorType: "system", actorRole: "system", result: "failed",
                module: "announcement-commands", operation: "releaseLease", error,
            }));
            this.iterationInProgress = false;
        }
    }

    /** Применяет одну команду и шлёт ack. Никогда не бросает. */
    private async applyOne(api: Api, command: AnnouncementCommand): Promise<boolean> {
        let failure: string | null = null;
        let result: ActionAckResult | undefined;
        try {
            if (command.kind === "SEND") await this.send(command);
            else if (command.kind === "TEST") await this.test(api, command);
            else if (command.kind === "REMIND") await this.remind(api, command);
            else if (command.kind === "STOP") await this.stop(command);
            else if (command.kind === "WITHDRAW") result = await this.withdraw(api, command);
            else if (command.kind === "EDIT") throw new CommandFailure("EDIT_NOT_IMPLEMENTED");
            else failure = `UNKNOWN_KIND: ${command.receivedKind}`.slice(0, 200);
        } catch (error) {
            failure = error instanceof CommandFailure ? error.code : "SEND_FAILED";
            logBusinessEvent({
                event: "bot.announcement_commands.command_failed",
                level: "error", actorType: "system", actorRole: "system", result: "failed",
                reasonCode: failure,
                module: "announcement-commands", operation: "applyOne",
                safeContext: { commandPublicId: command.publicId, kind: command.kind },
                error,
            });
        }

        try {
            if (failure === null) {
                if (result) await awsBusinessClient.ackAnnouncementCommandAccepted(command.publicId, result);
                else await awsBusinessClient.ackAnnouncementCommandAccepted(command.publicId);
            }
            else await awsBusinessClient.ackAnnouncementCommandFailed(command.publicId, failure);
        } catch (error) {
            // Потерянный ack не страшен: вебапп предложит команду снова, а дубль гасит publicId.
            logBusinessEvent({
                event: "bot.announcement_commands.ack_failed",
                level: "error", actorType: "system", actorRole: "system", result: "failed",
                reasonCode: "ACK_REQUEST_FAILED",
                module: "announcement-commands", operation: "ack",
                safeContext: { commandPublicId: command.publicId },
                error,
            });
            return false;
        }
        return failure === null;
    }

    private async send(command: Extract<AnnouncementCommand, { kind: "SEND" }>): Promise<void> {
        const existing = await broadcastRepository.findByPublicId(command.publicId);
        const recipients = [...new Set(command.recipients.filter(id => /^\d+$/u.test(id)))];
        if (!existing && recipients.length === 0) throw new CommandFailure("NO_RECIPIENTS");

        const buttonType = command.replyMode === "CONFIRM" ? "default" : "none";
        const reminders = buttonType === "default" ? command.reminders : null;
        const pingOptions = {
            buttonType: buttonType as "default" | "none",
            ...(reminders
                ? {
                    initialDelayMs: reminders.firstAfterMs,
                    repeatIntervalMs: reminders.everyMs,
                    pingUntil: new Date(reminders.untilIso),
                }
                : { noReminders: true }),
        };

        const media = command.attachments.length > 0 ? toMediaItems(command.attachments) : undefined;

        // Рассылка с недоступным вложением не создаётся: лучше отказ сразу, чем
        // половина адресатов без файла. Поток отменяется после заголовков.
        if (!existing && media) {
            for (const attachment of command.attachments) {
                try {
                    const opened = await awsBusinessClient.openAnnouncementAttachment(attachment.publicId);
                    await opened.stream.cancel().catch(() => undefined);
                } catch (error) {
                    throw new CommandFailure("ATTACHMENT_UNAVAILABLE", error);
                }
            }
        }

        if (existing) {
            // Строка есть, а задания могло не быть (сбой между вставкой и постановкой):
            // повторная постановка с тем же jobId безопасна и дубля отправки не даёт.
            await broadcastService.enqueueBroadcastJob({
                broadcastId: existing.id,
                initiatorId: WEBAPP_INITIATOR_ID,
                messageText: existing.messageText ?? command.messageHtml,
                target: { type: "pm_ids", value: recipients },
                media,
                botUsername: undefined,
                pingOptions,
                ...(command.textAsCaption ? { textAsCaption: true } : {}),
            });
            return;
        }

        try {
            await broadcastService.createBroadcast(
                null,
                WEBAPP_INITIATOR_ID,
                command.messageHtml,
                { type: "pm_ids", value: recipients },
                media,
                undefined,
                pingOptions,
                {
                    publicId: command.publicId, origin: "WEBAPP",
                    ...(command.authorName ? { authorName: command.authorName } : {}),
                    ...(command.textAsCaption ? { textAsCaption: true } : {}),
                },
            );
        } catch (error) {
            // Параллельный создатель успел первым: рассылка есть, второй отправки не будет.
            if (isUniqueViolation(error)) {
                const raced = await broadcastRepository.findByPublicId(command.publicId);
                if (raced) {
                    await broadcastService.enqueueBroadcastJob({
                        broadcastId: raced.id,
                        initiatorId: WEBAPP_INITIATOR_ID,
                        messageText: raced.messageText ?? command.messageHtml,
                        target: { type: "pm_ids", value: recipients },
                        media,
                        pingOptions,
                        ...(command.textAsCaption ? { textAsCaption: true } : {}),
                    });
                }
                return;
            }
            throw error;
        }
    }

    /**
     * «Remind» из вебаппа. Идемпотентно по publicId действия: журнал действий
     * закрывает повтор целиком, отметки по чатам — повтор после частичной отправки.
     * Ночью (или при `notBefore` в будущем) только ставит `manualRemindAt`: пингер
     * пошлёт на первом тике после него. Расписание автонапоминаний не трогаем.
     */
    private async remind(api: Api, command: Extract<AnnouncementCommand, { kind: "REMIND" }>): Promise<void> {
        if (await broadcastActionRepository.findLog(command.publicId)) return;
        const broadcast = await requireBroadcast(command.announcementPublicId);
        // Снята или остановлена между выдачей и исполнением: напоминать уже нечего.
        if (broadcast.withdrawnAt || broadcast.remindersStoppedAt) {
            await broadcastActionRepository.markDone(command.publicId, broadcast.id, "REMIND");
            return;
        }

        const now = new Date();
        const notBefore = command.notBefore ? new Date(command.notBefore) : null;
        const earliest = notBefore && !Number.isNaN(notBefore.getTime()) && notBefore > now ? notBefore : now;
        const at = new Date(Math.max(earliest.getTime(), nextAllowedPingTime(now).getTime()));

        if (at.getTime() > now.getTime()) {
            // Лиз вернулся уже после постановки: время не двигаем.
            if (broadcast.manualRemindActionId === command.publicId && broadcast.manualRemindAt) return;
            // Более раннее отложенное действие вытеснено новым: закрываем его, а не оставляем висеть.
            if (broadcast.manualRemindActionId && broadcast.manualRemindActionId !== command.publicId) {
                await broadcastActionRepository.markDone(broadcast.manualRemindActionId, broadcast.id, "REMIND");
            }
            await broadcastRepository.update(broadcast.id, { manualRemindAt: at, manualRemindActionId: command.publicId });
            await enqueueAnnouncementSyncSafe(broadcast.id);
            return;
        }

        const { failed } = await remindBroadcast({ api }, broadcast.id, command.publicId, now);
        // Не всем ушло: вебапп повторит (1/2/5/15 мин), отметки не дадут продублировать ушедшее.
        if (failed > 0) throw new CommandFailure("REMIND_FAILED");
        await broadcastActionRepository.markDone(command.publicId, broadcast.id, "REMIND");
    }

    private async stop(command: Extract<AnnouncementCommand, { kind: "STOP" }>): Promise<void> {
        if (await broadcastActionRepository.findLog(command.publicId)) return;
        const broadcast = await requireBroadcast(command.announcementPublicId);
        // Уже остановлены (в вебаппе или админкой бота): имя первого остановившего не затираем.
        if (!broadcast.remindersStoppedAt) await broadcastService.stopPinging(broadcast.id, command.actorName);
        await broadcastActionRepository.markDone(command.publicId, broadcast.id, "STOP");
    }

    /** Итог отзыва сохраняется в журнале: повторный ack несёт тот же результат, а не «0 чатов». */
    private async withdraw(api: Api, command: Extract<AnnouncementCommand, { kind: "WITHDRAW" }>): Promise<ActionAckResult> {
        const logged = await broadcastActionRepository.findLog(command.publicId);
        if (logged) return parseStoredResult(logged.result);
        const broadcast = await requireBroadcast(command.announcementPublicId);
        const outcome = await broadcastService.withdrawBroadcast(api, broadcast.id, { name: command.actorName });
        const result: ActionAckResult = { deletedChats: outcome.deletedChats, stayed: outcome.stayed };
        await broadcastActionRepository.markDone(command.publicId, broadcast.id, "WITHDRAW", result);
        await enqueueAnnouncementSyncSafe(broadcast.id);
        return result;
    }

    private async test(api: Api, command: Extract<AnnouncementCommand, { kind: "TEST" }>): Promise<void> {
        try {
            await broadcastService.sendTestBroadcast(
                api,
                Number(command.telegramId),
                command.messageHtml,
                command.attachments.length > 0 ? toMediaItems(command.attachments) : undefined,
                command.replyMode === "CONFIRM" ? "default" : "none",
                command.textAsCaption,
            );
        } catch (error) {
            throw new CommandFailure(describeTestFailure(error), error);
        }
    }
}

/** Вложение команды как элемент рассылки: file_id до первой отправки пуст. */
function toMediaItems(attachments: AnnouncementAttachment[]): BroadcastMediaItem[] {
    return attachments.map(a => ({
        type: a.kind,
        fileId: "",
        attachmentPublicId: a.publicId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        width: a.width,
        height: a.height,
        durationSec: a.durationSec,
    }));
}

type ActionAckResult = { deletedChats: number; stayed: string[] };

function parseStoredResult(value: unknown): ActionAckResult {
    const raw = (value ?? {}) as { deletedChats?: unknown; stayed?: unknown };
    return {
        deletedChats: typeof raw.deletedChats === "number" ? raw.deletedChats : 0,
        stayed: Array.isArray(raw.stayed) ? raw.stayed.map(String) : [],
    };
}

async function requireBroadcast(announcementPublicId: string) {
    const broadcast = await broadcastRepository.findByPublicId(announcementPublicId);
    if (!broadcast) throw new CommandFailure("BROADCAST_NOT_FOUND");
    return broadcast;
}

class CommandFailure extends Error {
    constructor(readonly code: string, cause?: unknown) {
        super(code, { cause });
    }
}

export const announcementCommandDispatcher = new AnnouncementCommandDispatcher();

/**
 * Запускает опрос раз в 15 с через `bot.api`. Выключен, пока
 * ANNOUNCEMENTS_COMMANDS_ENABLED не true; дубли между инстансами гасит лиз.
 */
export function startAnnouncementCommandPoller(api: Api): NodeJS.Timeout | undefined {
    if (!ANNOUNCEMENTS_COMMANDS_ENABLED) {
        logBusinessEvent({
            event: "bot.announcement_commands.disabled",
            actorType: "system", actorRole: "system", result: "skipped",
            reasonCode: "FEATURE_FLAG_OFF",
            module: "announcement-commands", operation: "startAnnouncementCommandPoller",
        });
        return undefined;
    }
    return setInterval(() => {
        announcementCommandDispatcher.runOnce(api).catch(error => {
            logger.error({ err: error }, "Announcement command dispatcher iteration failed");
        });
    }, ANNOUNCEMENT_COMMAND_POLL_MS);
}
