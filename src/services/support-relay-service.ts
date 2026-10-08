import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { SupportThread } from "@prisma/client";
import logger from "../core/logger.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import type { SupportThreadRepository } from "../repositories/support-thread-repository.js";
import { isAcknowledgement } from "../utils/support-thread-format.js";
import type { AlbumBuffer } from "../utils/album-buffer.js";
import { isTopicGoneError, type SupportThreadService } from "./support-thread-service.js";

/**
 * Пересилання між постійною темою і приватним чатом співробітниці (spec 2026-10-08):
 * пари повідомлень для цитат, правок і реакцій, статус теми, підтвердження.
 */

/** Пост бота в темі перед повідомленням: що за задача, зйомка, розсилка. */
export type ThreadContext = {
    /** Що бачить команда в темі (HTML, англійською). */
    topicHtml: string;
    /** Що бачить фотографиня цитатою, якщо підтримка відповість саме на цей пост. */
    contextText: string;
};

export type RelayDeps = {
    threads: Pick<SupportThreadService, "ensureThread" | "applyStatus" | "refreshCardIfStale" | "noticeIfAway" | "recreateTopic">;
    repo: Pick<SupportThreadRepository, "addLink" | "findLinkByPrivateMessage" | "findLinkByTopicMessage" | "update">;
    timeline: (userId: string, author: "USER" | "ADMIN", text: string, meta: Record<string, unknown>) => Promise<void>;
    albums: AlbumBuffer<Message>;
    now: () => Date;
    albumDelayMs?: number;
};

/** Текстове підтвердження — лише після такої тиші, щоб не відповідати на кожне повідомлення. */
const ACK_QUIET_MS = 6 * 60 * 60 * 1000;
const ACK_REACTION = "✍";

function describeError(error: unknown): string {
    const value = error as { description?: string; message?: string } | undefined;
    return String(value?.description ?? value?.message ?? error);
}

function isQuoteError(error: unknown): boolean {
    return /quote/i.test(describeError(error));
}

type ReplyParameters = {
    message_id: number;
    allow_sending_without_reply: true;
    quote?: string;
    quote_position?: number;
};

export function messagePreview(message: Message): string {
    const text = message.text ?? message.caption;
    if (text) return text;
    if (message.photo) return "[photo]";
    if (message.video) return "[video]";
    if (message.voice) return "[voice]";
    if (message.video_note) return "[video note]";
    if (message.document) return "[document]";
    if (message.sticker) return `[sticker ${message.sticker.emoji ?? ""}]`.trim();
    return "[message]";
}

export class SupportRelayService {
    constructor(private readonly deps: RelayDeps) {}

    async relayStaffMessage(
        api: Api,
        input: { userId: string; chatId: number; message: Message; contexts: ThreadContext[] },
    ): Promise<"delivered" | "failed"> {
        const { userId, chatId, message } = input;
        let thread: SupportThread;
        try {
            thread = await this.deps.threads.ensureThread(api, userId);
            await this.deps.threads.refreshCardIfStale(api, thread).catch(error => logger.warn({ err: error, threadId: thread.id }, "Support card refresh failed"));
            thread = await this.deps.threads.noticeIfAway(api, thread).catch(error => {
                logger.warn({ err: error, threadId: thread.id }, "Support away notice failed");
                return thread;
            });
            for (const context of input.contexts) await this.postContext(api, thread, context);
        } catch (error) {
            logger.error({ err: error, userId }, "Support thread could not be prepared for a staff message");
            await this.tellStaffItFailed(api, chatId);
            return "failed";
        }

        if (message.media_group_id) {
            const key = `${chatId}:${message.media_group_id}`;
            this.deps.albums.add(key, message, items => this.flushStaffAlbum(api, userId, chatId, items), this.deps.albumDelayMs ?? 1000);
            return "delivered";
        }

        const reply = await this.replyParametersForStaff(chatId, message, thread);
        let copiedId: number;
        try {
            const copied = await this.copyIntoTopic(api, thread, chatId, message.message_id, reply);
            thread = copied.thread;
            copiedId = copied.messageId;
        } catch (error) {
            logger.error({ err: error, userId, threadId: thread.id }, "Staff message could not reach the support topic");
            await this.tellStaffItFailed(api, chatId);
            return "failed";
        }

        await this.deps.repo.addLink({
            threadId: thread.id,
            direction: "IN",
            topicChatId: thread.chatId,
            topicMessageId: copiedId,
            privateChatId: BigInt(chatId),
            privateMessageId: message.message_id,
        });
        await this.afterStaffDelivery(api, thread, userId, chatId, message, isAcknowledgement(message));
        return "delivered";
    }

    /** Пост бота в темі (звіт по задачі, заперечення розсилки) без повідомлення фотографині. */
    async postBotContext(
        api: Api,
        userId: string,
        context: ThreadContext,
        sendItems?: (topicChatId: number, topicId: number) => Promise<number[]>,
    ): Promise<void> {
        let thread = await this.deps.threads.ensureThread(api, userId);
        await this.deps.threads.refreshCardIfStale(api, thread).catch(() => undefined);
        await this.postContext(api, thread, context);
        if (sendItems) {
            const ids = await sendItems(Number(thread.chatId), thread.topicId);
            for (const id of ids) {
                await this.deps.repo.addLink({ threadId: thread.id, direction: "CONTEXT", topicChatId: thread.chatId, topicMessageId: id, contextText: context.contextText });
            }
        }
        thread = await this.deps.threads.applyStatus(api, thread, { kind: "bot_context" });
    }

    private async postContext(api: Api, thread: SupportThread, context: ThreadContext) {
        const sent = await api.sendMessage(Number(thread.chatId), context.topicHtml, { message_thread_id: thread.topicId, parse_mode: "HTML" });
        await this.deps.repo.addLink({
            threadId: thread.id,
            direction: "CONTEXT",
            topicChatId: thread.chatId,
            topicMessageId: sent.message_id,
            contextText: context.contextText,
        });
    }

    private async replyParametersForStaff(chatId: number, message: Message, thread: SupportThread): Promise<ReplyParameters | undefined> {
        const repliedId = message.reply_to_message?.message_id;
        if (!repliedId) return undefined;
        const link = await this.deps.repo.findLinkByPrivateMessage(BigInt(chatId), repliedId);
        if (!link || link.threadId !== thread.id) return undefined;
        return withQuote({ message_id: link.topicMessageId, allow_sending_without_reply: true }, message);
    }

    /**
     * Копія в тему з двома відкатами: цитата не прийнялась (текст правили) — без
     * цитати; тему видалили руками — нова тема і повтор без відповіді.
     */
    private async copyIntoTopic(
        api: Api,
        thread: SupportThread,
        fromChatId: number,
        messageId: number,
        reply: ReplyParameters | undefined,
    ): Promise<{ thread: SupportThread; messageId: number }> {
        const options = (target: SupportThread, replyParameters?: ReplyParameters) => ({
            message_thread_id: target.topicId,
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        });
        try {
            const copied = await api.copyMessage(Number(thread.chatId), fromChatId, messageId, options(thread, reply));
            return { thread, messageId: copied.message_id };
        } catch (error) {
            if (reply?.quote && isQuoteError(error)) {
                const { quote: _quote, quote_position: _position, ...plain } = reply;
                const copied = await api.copyMessage(Number(thread.chatId), fromChatId, messageId, options(thread, plain));
                return { thread, messageId: copied.message_id };
            }
            if (isTopicGoneError(error)) {
                const recreated = await this.deps.threads.recreateTopic(api, thread);
                const copied = await api.copyMessage(Number(recreated.chatId), fromChatId, messageId, options(recreated));
                return { thread: recreated, messageId: copied.message_id };
            }
            throw error;
        }
    }

    private async flushStaffAlbum(api: Api, userId: string, chatId: number, items: Message[]) {
        const messages = [...items].sort((a, b) => a.message_id - b.message_id);
        let thread = await this.deps.threads.ensureThread(api, userId);
        const ids = messages.map(item => item.message_id);
        let copied: { message_id: number }[];
        try {
            copied = await api.copyMessages(Number(thread.chatId), chatId, ids, { message_thread_id: thread.topicId });
        } catch (error) {
            if (!isTopicGoneError(error)) {
                logger.error({ err: error, userId }, "Staff album could not reach the support topic");
                await this.tellStaffItFailed(api, chatId);
                return;
            }
            thread = await this.deps.threads.recreateTopic(api, thread);
            copied = await api.copyMessages(Number(thread.chatId), chatId, ids, { message_thread_id: thread.topicId });
        }
        for (let index = 0; index < messages.length && index < copied.length; index++) {
            await this.deps.repo.addLink({
                threadId: thread.id,
                direction: "IN",
                topicChatId: thread.chatId,
                topicMessageId: copied[index]!.message_id,
                privateChatId: BigInt(chatId),
                privateMessageId: messages[index]!.message_id,
            });
        }
        await this.afterStaffDelivery(api, thread, userId, chatId, messages[0]!, false);
    }

    private async afterStaffDelivery(api: Api, thread: SupportThread, userId: string, chatId: number, message: Message, isAck: boolean) {
        const now = this.deps.now();
        const quietSince = thread.lastStaffAt;
        const updated = await this.deps.threads.applyStatus(api, thread, { kind: isAck ? "staff_ack" : "staff_question" });
        await this.deps.repo.update(updated.id, { lastStaffAt: now, ...(isAck ? {} : { lastQuestionAt: now }) });

        await api.setMessageReaction(chatId, message.message_id, [{ type: "emoji", emoji: ACK_REACTION }]).catch(error => {
            logger.debug({ err: error }, "Support delivery reaction could not be set");
        });
        const quiet = !quietSince || now.getTime() - quietSince.getTime() >= ACK_QUIET_MS;
        if (quiet && !isAck) {
            await api.sendMessage(chatId, STAFF_TEXTS["support-thread-ack"]).catch(error => {
                logger.warn({ err: error, userId }, "Support acknowledgement could not be sent");
            });
        }
        await this.deps.timeline(userId, "USER", messagePreview(message), { threadId: thread.id }).catch(error => {
            logger.warn({ err: error, userId }, "Support timeline event failed");
        });
    }

    private async tellStaffItFailed(api: Api, chatId: number) {
        await api.sendMessage(chatId, STAFF_TEXTS["support-thread-failed"]).catch(error => {
            logger.error({ err: error, chatId }, "Support failure notice could not be sent");
        });
    }
}

function withQuote(base: ReplyParameters, message: Message): ReplyParameters {
    const quote = message.quote;
    if (!quote?.text) return base;
    return { ...base, quote: quote.text, quote_position: quote.position };
}
