import { Readable } from "node:stream";
import { InputFile } from "grammy";
import logger from "../core/logger.js";
import { PING_CONFIG } from "../config.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
import { broadcastActionRepository } from "../repositories/broadcast-action-repository.js";
import { broadcastDeliveryRepository } from "../repositories/broadcast-delivery-repository.js";
import { pendingReplyRepository } from "../repositories/pending-reply-repository.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { nextAllowedPingTime } from "../utils/quiet-hours.js";
import { enqueueAnnouncementSyncSafe } from "./announcement-sync.js";
import { fileIdOf, hasVisibleText, isAttachmentGone } from "./announcement-parts.js";
import { awsBusinessClient, type AnnouncementAttachment, type AnnouncementCommand } from "./aws-business-client.js";
import { buildBroadcastKeyboard, getBroadcastFollowUpText } from "./broadcast.js";

export type EditCommand = Extract<AnnouncementCommand, { kind: "EDIT" }>;

type ButtonType = "default" | "preferences" | "none";

/** Тот самый текст, который уходит людям вместе с теми же двумя кнопками. */
export const RECONFIRM_PROMPT = "Оновили текст вище — перечитай і підтверди, будь ласка";

/** Команда не выполнена целиком: код уходит в failed-ack, вебапп повторит. */
export class AnnouncementEditFailure extends Error {
    constructor(readonly code: string, cause?: unknown) {
        super(code, { cause });
    }
}

export interface EditOutcome {
    /** Чатов, где сообщения обновлены (включая «не изменилось»). */
    edited: number;
    /** Чатов, где правка не удалась (удалён чат, бот заблокирован...). */
    failed: number;
    /** Сколько людям ушло «Оновили текст вище…». */
    reconfirmed: number;
}

const errorText = (error: unknown): string => {
    const e = error as { description?: string; message?: string } | null;
    return e?.description || e?.message || String(error);
};

/** Telegram отвечает 400, когда новый текст совпадает со старым: правка и так применена. */
const isNotModified = (error: unknown): boolean => /message is not modified/iu.test(errorText(error));

type EditableMessage = { message_id?: number; photo?: Array<{ file_id: string }>; video?: { file_id: string }; document?: { file_id: string } };

/**
 * Правка отправленной рассылки из вебаппа: текст (подпись), замены вложений и,
 * по желанию, переподтверждение. Идемпотентно по publicId команды: журнал
 * закрывает повтор целиком, отметки по чатам — повтор после частичной отправки
 * (лиз мог истечь посреди переподтверждения, второе сообщение никому не уходит).
 * Сбой отдельного чата команду не валит; она падает, только если не удалось
 * нигде при ≥ 1 доставке.
 */
export async function applyAnnouncementEdit(api: any, broadcastId: number, command: EditCommand): Promise<EditOutcome> {
    const none: EditOutcome = { edited: 0, failed: 0, reconfirmed: 0 };
    const logged = await broadcastActionRepository.findLog(command.publicId);
    if (logged) {
        // Повтор после потерянного ack: итог тот же, что был, а не «0 чатов».
        const stored = (logged.result ?? {}) as { edited?: unknown; failed?: unknown };
        return {
            edited: typeof stored.edited === "number" ? stored.edited : 0,
            failed: typeof stored.failed === "number" ? stored.failed : 0,
            reconfirmed: 0,
        };
    }

    const broadcast = await broadcastRepository.findById(broadcastId);
    if (!broadcast) throw new AnnouncementEditFailure("BROADCAST_NOT_FOUND");
    // Снята: сообщений в чатах уже нет, править нечего.
    if (broadcast.withdrawnAt) {
        await broadcastActionRepository.markDone(command.publicId, broadcastId, "EDIT");
        return none;
    }

    const buttonType = (broadcast.buttonType ?? broadcast.trackedMessages[0]?.buttonType ?? "none") as ButtonType;
    const deliveries = await broadcastDeliveryRepository.findSentForEdit(broadcastId);
    const textAsCaption = broadcast.textAsCaption;
    const visible = hasVisibleText(command.messageHtml);
    // Пустой текст при кнопках — служебная строка, как при отправке; без кнопок текста нет.
    const messageText = visible ? command.messageHtml : (!textAsCaption && buttonType !== "none" ? getBroadcastFollowUpText(buttonType) : "");

    const fileIds = await broadcastRepository.getMediaFileIds(broadcastId);
    const sources = new Map<string, AnnouncementAttachment>();
    for (const r of command.replacements) sources.set(r.attachment.publicId, r.attachment);

    // До первой правки проверяем, что ещё не загруженный в Telegram файл отдаётся:
    // иначе часть чатов получила бы новый текст со старой картинкой.
    if (deliveries.length > 0) {
        for (const attachment of sources.values()) {
            if (fileIds[attachment.publicId]) continue;
            try {
                const probe = await awsBusinessClient.openAnnouncementAttachment(attachment.publicId);
                await probe.stream.cancel().catch(() => undefined);
            } catch (error) {
                throw new AnnouncementEditFailure(isAttachmentGone(error) ? "ATTACHMENT_UNAVAILABLE" : "EDIT_FAILED", error);
            }
        }
    }

    const openedStreams: Readable[] = [];
    const rememberFileId = async (publicId: string, fileId: string) => {
        if (fileIds[publicId] === fileId) return;
        fileIds[publicId] = fileId;
        await broadcastRepository.update(broadcastId, { mediaFileIds: { ...fileIds } }).catch(error => {
            logger.error({ err: error, broadcastId }, "Failed to persist announcement media file ids");
        });
    };
    // Источник — функция: autoRetry grammY повторяет запрос, каждая попытка берёт свежий поток.
    const source = (attachment: AnnouncementAttachment): string | InputFile => {
        const known = fileIds[attachment.publicId];
        if (known) return known;
        return new InputFile(async () => {
            const opened = await awsBusinessClient.openAnnouncementAttachment(attachment.publicId);
            const readable = Readable.fromWeb(opened.stream as never);
            openedStreams.push(readable);
            return readable;
        }, attachment.fileName || "file");
    };

    const now = new Date();
    // Чаты, которым эта команда уже слала переподтверждение (прошлый заход оборвался): их ответы
    // — уже ответы на него, кнопки обратно не возвращаем.
    const alreadyReconfirmed = command.reconfirm
        ? await broadcastActionRepository.findMarkedChats(broadcastId, command.publicId)
        : new Set<string>();
    const trackedByChat = new Map<string, typeof broadcast.trackedMessages>();
    for (const t of broadcast.trackedMessages) {
        const key = String(t.chatId);
        trackedByChat.set(key, [...(trackedByChat.get(key) ?? []), t]);
    }

    let botUsername: string | undefined;
    if (buttonType === "default" && deliveries.some(d => d.targetType === "GROUP")) {
        try {
            botUsername = (await api.getMe())?.username;
        } catch (error) {
            // Без имени бота кнопка «Не згодна» в группе станет обычной callback-кнопкой.
            logger.warn({ err: error, broadcastId }, "getMe failed while editing a group announcement; decline button falls back to callback");
        }
    }
    const keyboard = (delivery: { targetType: string }): Record<string, unknown> =>
        buttonType === "none"
            ? {}
            : { reply_markup: buildBroadcastKeyboard(buttonType, broadcastId, botUsername, delivery.targetType === "GROUP") };
    const trackedOf = (delivery: { chatId: bigint }) => trackedByChat.get(String(delivery.chatId)) ?? [];
    /**
     * Клавиатура правки. Группе — всегда; личке — пока ответ ждётся или команда его
     * сбросит переподтверждением. Ответившей без переподтверждения кнопок нет (так в чате
     * сейчас), а Telegram при правке без reply_markup их и не вернёт.
     */
    const markupFor = (delivery: { targetType: string; chatId: bigint }): Record<string, unknown> => {
        if (delivery.targetType !== "GROUP") {
            const replies = trackedOf(delivery).flatMap(t => t.pendingReplies);
            const waiting = replies.some(r => r.status === "pending");
            const willReset = command.reconfirm && !alreadyReconfirmed.has(String(delivery.chatId)) && replies.some(r => r.status === "confirmed" || r.status === "declined");
            if (!waiting && !willReset) return {};
        }
        return keyboard(delivery);
    };

    const editMedia = async (chatId: number, messageId: number, attachment: AnnouncementAttachment, extra: Record<string, unknown>) => {
        const file = source(attachment);
        const media: Record<string, unknown> = attachment.kind === "video"
            ? {
                type: "video", media: file, supports_streaming: true,
                ...(attachment.width ? { width: attachment.width } : {}),
                ...(attachment.height ? { height: attachment.height } : {}),
                ...(attachment.durationSec ? { duration: attachment.durationSec } : {}),
            }
            : { type: attachment.kind, media: file };
        const { reply_markup, ...captionOptions } = extra;
        Object.assign(media, captionOptions);
        const result = await api.editMessageMedia(chatId, messageId, media, reply_markup ? { reply_markup } : undefined)
            .catch((error: unknown) => {
                if (isNotModified(error)) return null;
                throw error;
            }) as EditableMessage | true | null;
        // Новый file_id — следующим чатам не нужно тянуть файл потоком снова.
        if (result && typeof result === "object") {
            const learned = fileIdOf({ type: attachment.kind } as never, result as never);
            if (learned) await rememberFileId(attachment.publicId, learned);
        }
    };

    const editDelivery = async (delivery: (typeof deliveries)[number]): Promise<void> => {
        const chatId = Number(delivery.chatId);
        const parts = delivery.partMessageIds;
        let textHandledByMedia = false;
        for (const { position, attachment } of command.replacements) {
            const messageId = parts[position];
            if (messageId === undefined) throw new Error(`PART_NOT_FOUND:${position}`);
            const carriesText = textAsCaption && messageId === delivery.messageId;
            await editMedia(chatId, messageId, attachment, carriesText
                ? { ...(messageText ? { caption: messageText } : {}), parse_mode: "HTML", ...markupFor(delivery) }
                : {});
            if (carriesText) textHandledByMedia = true;
        }
        if (delivery.messageId == null || textHandledByMedia) return;
        // Текст отдельным сообщением есть (старый непустой), а новый пуст и служебной строки нет:
        // записать пустоту в чат нельзя, молча пропустить значит оставить старый текст.
        if (!textAsCaption && !messageText && hasVisibleText(broadcast.messageText ?? "")) {
            throw new Error("EMPTY_TEXT_MESSAGE");
        }
        try {
            if (textAsCaption) {
                await api.editMessageCaption(chatId, delivery.messageId, {
                    caption: messageText, parse_mode: "HTML", ...markupFor(delivery),
                });
            } else if (messageText) {
                await api.editMessageText(chatId, delivery.messageId, messageText, {
                    parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markupFor(delivery),
                });
            }
        } catch (error) {
            if (!isNotModified(error)) throw error;
        }
    };

    /** Переподтверждение одного чата: сброс ответов, сообщение ответом на правленое, id в доставку. */
    const reconfirmChat = async (delivery: (typeof deliveries)[number]): Promise<boolean> => {
        if (buttonType === "none") return false;
        const tracked = trackedOf(delivery);
        const answered = tracked.flatMap(t => t.pendingReplies.filter(r => r.status === "confirmed" || r.status === "declined"));
        if (answered.length === 0) return false;
        // Уже спрашивали этой командой — второй раз не шлём.
        if (!(await broadcastActionRepository.claimReminderMark(broadcastId, delivery.chatId, command.publicId))) return false;

        // Напоминания возвращаем ДО отправки: сбой после сброса не оставит людей без напоминания.
        // Условие — устойчивый факт рассылки (remindersEnabled), а не остатки в строках: stopTracking
        // обнуляет nextPingAt, а у рассылок бота интервала в строке нет.
        const resumed: Array<{ id: number; nextPingAt: Date | null }> = [];
        const restore = async () => {
            for (const r of answered) {
                await pendingReplyRepository.update(r.id, { status: r.status, respondedAt: r.respondedAt }).catch(() => undefined);
            }
            for (const t of resumed) {
                await trackedMessageRepository.update(t.id, { nextPingAt: t.nextPingAt }).catch(() => undefined);
            }
            await broadcastActionRepository.releaseReminderMark(delivery.chatId, command.publicId).catch(() => undefined);
        };
        const canRemind = broadcast.remindersEnabled && !broadcast.remindersStoppedAt && !broadcast.withdrawnAt;
        let sent: { message_id: number };
        try {
            if (canRemind) {
                for (const t of tracked) {
                    if (!t.pendingReplies.some(r => answered.includes(r))) continue;
                    if (t.pingUntil && t.pingUntil.getTime() <= now.getTime()) continue;
                    resumed.push({ id: t.id, nextPingAt: t.nextPingAt });
                    await trackedMessageRepository.update(t.id, {
                        nextPingAt: nextAllowedPingTime(new Date(now.getTime() + (t.pingIntervalMs ?? PING_CONFIG.REPEAT_DELAY_MS))),
                    });
                }
            }
            await pendingReplyRepository.updateMany({ id: { in: answered.map(r => r.id) } }, { status: "pending", respondedAt: null });
            sent = await api.sendMessage(Number(delivery.chatId), RECONFIRM_PROMPT, {
                reply_parameters: { message_id: delivery.messageId ?? tracked[0]?.messageId, allow_sending_without_reply: true },
                parse_mode: "HTML",
                ...keyboard(delivery),
            });
        } catch (error) {
            // Сбой на любом шаге (перенос напоминаний, сброс ответов, отправка): всё возвращаем и снимаем
            // отметку, чтобы повтор команды мог начать заново, а nextPingAt не остался сдвинутым.
            await restore();
            throw error;
        }
        await broadcastDeliveryRepository.appendPartMessageId(delivery.id, sent.message_id);

        return true;
    };

    const outcome: EditOutcome = { edited: 0, failed: 0, reconfirmed: 0 };
    let lastError: unknown;
    try {
        for (const delivery of deliveries) {
            try {
                await editDelivery(delivery);
                outcome.edited++;
            } catch (error) {
                outcome.failed++;
                lastError = error;
                logger.warn({ err: error, broadcastId, chatId: String(delivery.chatId) }, "Announcement edit failed in chat");
                continue;
            }
            if (!command.reconfirm) continue;
            try {
                if (await reconfirmChat(delivery)) outcome.reconfirmed++;
            } catch (error) {
                logger.warn({ err: error, broadcastId, chatId: String(delivery.chatId) }, "Announcement reconfirm failed in chat");
            }
        }
    } finally {
        for (const readable of openedStreams) readable.destroy();
    }

    // Ни одного чата — повторить позже; в вебаппе «не удалось», а не «успех».
    if (deliveries.length > 0 && outcome.edited === 0) throw new AnnouncementEditFailure("EDIT_FAILED", lastError);

    const kinds = [...(broadcast.attachmentKinds ?? [])];
    for (const { position, attachment } of command.replacements) {
        if (position < kinds.length) kinds[position] = attachment.kind;
    }
    await broadcastRepository.update(broadcastId, {
        messageText: command.messageHtml,
        ...(command.replacements.length > 0 ? { attachmentKinds: kinds } : {}),
    });
    await broadcastActionRepository.markDone(command.publicId, broadcastId, "EDIT", {
        edited: outcome.edited,
        failed: outcome.failed,
    });
    await enqueueAnnouncementSyncSafe(broadcastId);
    return outcome;
}
