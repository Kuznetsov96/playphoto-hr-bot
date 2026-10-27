import type { Api } from "grammy";
import logger from "../core/logger.js";
import { ANNOUNCEMENTS_COMMANDS_ENABLED } from "../config.js";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
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
        try {
            if (command.kind === "SEND") await this.send(command);
            else if (command.kind === "TEST") await this.test(api, command);
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
            if (failure === null) await awsBusinessClient.ackAnnouncementCommandAccepted(command.publicId);
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
