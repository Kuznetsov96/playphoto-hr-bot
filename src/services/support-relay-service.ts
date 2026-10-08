import type { Api } from "grammy";
import type { Message, MessageEntity, MessageReactionUpdated, ReactionTypeEmoji } from "grammy/types";
import type { SupportThread } from "@prisma/client";
import logger from "../core/logger.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import type { SupportThreadRepository } from "../repositories/support-thread-repository.js";
import { isAcknowledgement } from "../utils/support-thread-format.js";
import { escapeHtml, msgToHtml } from "../handlers/admin/utils.js";
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
    repo: Pick<SupportThreadRepository, "addLink" | "findLinkByPrivateMessage" | "findLinkByTopicMessage" | "update" | "findByTopic" | "findLegacyUserByTopic">;
    timeline: (userId: string, author: "USER" | "ADMIN", text: string, meta: Record<string, unknown>) => Promise<void>;
    albums: AlbumBuffer<Message>;
    now: () => Date;
    albumDelayMs?: number;
    supportChatId: () => number;
    /** Приватний чат співробітниці (її telegramId). */
    getStaffChatId: (userId: string) => Promise<number | null>;
    /** Ролі підтримки: лише їхні повідомлення в темі йдуть фотографині. */
    isSupportMember: (telegramId: number) => boolean;
    topicLink: (chatId: bigint, topicId: number) => string;
};

/** Від імені групи Telegram підставляє цей службовий акаунт. */
const ANONYMOUS_ADMIN_ID = 1087968824;
/** Цитата контексту не довша за це — щоб підпис фото вліз у 1024 символи. */
const CONTEXT_QUOTE_LIMIT = 200;

/** Що з повідомлення в темі має сенс для фотографині; решта — службове. */
const RELAYABLE_KEYS = [
    "text", "photo", "video", "document", "voice", "video_note", "audio", "animation", "sticker",
    "contact", "location", "venue", "poll", "dice", "rich_message", "checklist",
] as const;

function isRelayable(message: Message): boolean {
    const record = message as unknown as Record<string, unknown>;
    return RELAYABLE_KEYS.some(key => record[key] !== undefined);
}

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

function canCarryCaption(message: Message): boolean {
    return Boolean(message.photo || message.video || message.document || message.audio || message.animation || message.voice);
}

function contextQuoteHtml(contextText: string): string {
    const trimmed = contextText.length > CONTEXT_QUOTE_LIMIT ? `${contextText.slice(0, CONTEXT_QUOTE_LIMIT - 1)}…` : contextText;
    return `<blockquote>${escapeHtml(trimmed)}</blockquote>\n`;
}

function emojiReactions(reactions: MessageReactionUpdated["new_reaction"]): ReactionTypeEmoji[] {
    return reactions.filter((reaction): reaction is ReactionTypeEmoji => reaction.type === "emoji").map(reaction => ({ type: "emoji", emoji: reaction.emoji }));
}

function isBlockedError(error: unknown): boolean {
    const value = error as { error_code?: number } | undefined;
    return value?.error_code === 403 || /blocked|deactivated/i.test(describeError(error));
}

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
    ): Promise<"delivered" | "failed" | "ignored"> {
        const { userId, chatId, message } = input;
        // Службові події приватного чату (закріп, фон, таймер) — не повідомлення людині.
        if (!isRelayable(message)) return "ignored";
        let thread: SupportThread;
        try {
            thread = await this.deps.threads.ensureThread(api, userId);
            await this.deps.threads.refreshCardIfStale(api, thread).catch(error => logger.warn({ err: error, threadId: thread.id }, "Support card refresh failed"));
            thread = await this.deps.threads.noticeIfAway(api, thread).catch(error => {
                logger.warn({ err: error, threadId: thread.id }, "Support away notice failed");
                return thread;
            });
            for (const context of input.contexts) {
                thread = await this.onTopic(api, thread, target => this.postContext(api, target, context));
            }
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

    /**
     * Менеджерка пише співробітниці з адмінки бота: фотографині — копія, у тему —
     * рядок «звідки» і та сама копія, щоб розмова лишалась в одному місці.
     * Не дійшло фотографині — помилка для екрана адмінки; не вдалась копія в тему —
     * лише лог, бо повідомлення вже доставлене.
     */
    async sendFromAdminPanel(
        api: Api,
        input: { adminChatId: number; message: Message; admin: { id: number; firstName: string }; userId: string; fallbackSend?: (staffChatId: number) => Promise<void> },
    ): Promise<{ topicUrl: string; title: string }> {
        const { adminChatId, message, admin, userId } = input;
        let thread = await this.deps.threads.ensureThread(api, userId);
        const staffChatId = await this.deps.getStaffChatId(userId);
        if (!staffChatId) throw new Error("This person has no Telegram account in the bot");

        let privateMessageId: number | null = null;
        if ((message.rich_message || message.checklist) && input.fallbackSend) {
            await input.fallbackSend(staffChatId);
        } else {
            privateMessageId = (await api.copyMessage(staffChatId, adminChatId, message.message_id)).message_id;
        }

        try {
            await api.sendMessage(Number(thread.chatId), `↗ Sent from the bot by ${escapeHtml(admin.firstName)}`, { message_thread_id: thread.topicId });
            const copied = await api.copyMessage(Number(thread.chatId), adminChatId, message.message_id, { message_thread_id: thread.topicId });
            await this.deps.repo.addLink({
                threadId: thread.id,
                direction: "OUT",
                topicChatId: thread.chatId,
                topicMessageId: copied.message_id,
                privateChatId: BigInt(staffChatId),
                privateMessageId,
            });
        } catch (error) {
            logger.warn({ err: error, threadId: thread.id }, "Admin-panel message could not be mirrored into the support topic");
        }
        thread = await this.afterSupportDelivery(api, thread, admin, message);
        return { topicUrl: this.deps.topicLink(thread.chatId, thread.topicId), title: thread.title };
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
        thread = await this.onTopic(api, thread, target => this.postContext(api, target, context));
        if (sendItems) {
            const ids = await sendItems(Number(thread.chatId), thread.topicId);
            for (const id of ids) {
                await this.deps.repo.addLink({ threadId: thread.id, direction: "CONTEXT", topicChatId: thread.chatId, topicMessageId: id, contextText: context.contextText });
            }
        }
        thread = await this.deps.threads.applyStatus(api, thread, { kind: "bot_context" });
    }

    /**
     * Повідомлення команди в темі людини (або в її старій темі) → фотографині.
     * "ignored" — не наша тема чи службове повідомлення; обробник віддає далі.
     */
    async relaySupportMessage(
        api: Api,
        input: { message: Message; sender: { id: number; firstName: string }; fallbackSend?: (staffChatId: number) => Promise<void> },
    ): Promise<"delivered" | "ignored" | "failed"> {
        const { message, sender } = input;
        const chatId = this.deps.supportChatId();
        const topicId = message.is_topic_message ? message.message_thread_id : undefined;
        if (!topicId || !isRelayable(message)) return "ignored";

        const resolved = await this.resolveTopic(api, chatId, topicId);
        if (!resolved) return "ignored";
        let { thread } = resolved;

        const note = (text: string) => api.sendMessage(chatId, text, {
            message_thread_id: topicId,
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        }).catch(error => logger.warn({ err: error, threadId: thread.id }, "Support delivery note failed"));

        if (sender.id === ANONYMOUS_ADMIN_ID || message.sender_chat) {
            await note("⚠️ Not delivered: you're posting anonymously. Turn off “Remain anonymous” in your admin rights and send again.");
            return "failed";
        }
        if (!this.deps.isSupportMember(sender.id)) {
            await note("⚠️ Not delivered: you're not on the support team list. Ask the owner to add your Telegram ID.");
            return "failed";
        }

        const staffChatId = await this.deps.getStaffChatId(thread.userId);
        if (!staffChatId) {
            await note("❌ Not delivered: this person has no Telegram account in the bot.");
            return "failed";
        }

        if ((message.rich_message || message.checklist) && input.fallbackSend) {
            try {
                await input.fallbackSend(staffChatId);
            } catch (error) {
                await note(this.deliveryFailureText(thread, error));
                return "failed";
            }
            await this.afterSupportDelivery(api, thread, sender, message);
            await this.noticeLegacy(api, resolved, chatId, topicId);
            return "delivered";
        }

        if (message.media_group_id) {
            const key = `${chatId}:${message.media_group_id}`;
            this.deps.albums.add(key, message, items => this.flushSupportAlbum(api, thread, staffChatId, sender, items), this.deps.albumDelayMs ?? 1000);
            await this.noticeLegacy(api, resolved, chatId, topicId);
            return "delivered";
        }

        let delivered: { messageId: number; contextText: string | null };
        try {
            delivered = await this.sendToStaff(api, thread, chatId, staffChatId, message);
        } catch (error) {
            logger.warn({ err: error, threadId: thread.id }, "Support reply could not reach the photographer");
            await note(this.deliveryFailureText(thread, error));
            return "failed";
        }

        await this.deps.repo.addLink({
            threadId: thread.id,
            direction: "OUT",
            topicChatId: BigInt(chatId),
            topicMessageId: message.message_id,
            privateChatId: BigInt(staffChatId),
            privateMessageId: delivered.messageId,
            contextText: delivered.contextText,
        });
        thread = await this.afterSupportDelivery(api, thread, sender, message);
        await this.noticeLegacy(api, resolved, chatId, topicId);
        return "delivered";
    }

    async relayEdit(api: Api, message: Message, side: "staff" | "support"): Promise<void> {
        const link = side === "staff"
            ? await this.deps.repo.findLinkByPrivateMessage(BigInt(message.chat.id), message.message_id)
            : await this.deps.repo.findLinkByTopicMessage(BigInt(message.chat.id), message.message_id);
        if (!link) return;
        const expected = side === "staff" ? "IN" : "OUT";
        if (link.direction !== expected) return;

        const [targetChat, targetMessage] = side === "staff"
            ? [Number(link.topicChatId), link.topicMessageId]
            : [Number(link.privateChatId), link.privateMessageId];
        if (!targetChat || !targetMessage) return;

        const context = side === "support" ? link.contextText : null;
        try {
            if (message.text !== undefined) {
                if (context) {
                    await api.editMessageText(targetChat, targetMessage, contextQuoteHtml(context) + msgToHtml(message.text, message.entities ?? []), { parse_mode: "HTML" });
                } else {
                    await api.editMessageText(targetChat, targetMessage, message.text, { entities: message.entities ?? [] });
                }
            } else if (message.caption !== undefined) {
                if (context) {
                    await api.editMessageCaption(targetChat, targetMessage, { caption: contextQuoteHtml(context) + msgToHtml(message.caption, message.caption_entities ?? []), parse_mode: "HTML" });
                } else {
                    await api.editMessageCaption(targetChat, targetMessage, { caption: message.caption, caption_entities: message.caption_entities ?? [] });
                }
            } else {
                logger.info({ side, messageId: message.message_id }, "Support edit without text or caption is not relayed");
            }
        } catch (error) {
            if (!/message is not modified/i.test(describeError(error))) {
                logger.warn({ err: error, side, messageId: message.message_id }, "Support edit could not be relayed");
            }
        }
    }

    async relayReaction(api: Api, update: MessageReactionUpdated, side: "staff" | "support"): Promise<void> {
        if (update.user?.is_bot) return;
        const reactions = emojiReactions(update.new_reaction);

        if (side === "support") {
            if (!update.user || !this.deps.isSupportMember(update.user.id)) return;
            const link = await this.deps.repo.findLinkByTopicMessage(BigInt(update.chat.id), update.message_id);
            if (!link || link.direction !== "IN" || !link.privateChatId || !link.privateMessageId) return;
            await api.setMessageReaction(Number(link.privateChatId), link.privateMessageId, reactions).catch(error => {
                logger.debug({ err: error }, "Support reaction could not be mirrored to the photographer");
            });
            if (reactions.some(reaction => reaction.emoji === "👍") && link.thread) {
                await this.deps.threads.applyStatus(api, link.thread, { kind: "support_thumbs_up", actorTelegramId: BigInt(update.user.id) });
            }
            return;
        }

        const link = await this.deps.repo.findLinkByPrivateMessage(BigInt(update.chat.id), update.message_id);
        if (!link || link.direction !== "OUT") return;
        await api.setMessageReaction(Number(link.topicChatId), link.topicMessageId, reactions).catch(error => {
            logger.debug({ err: error }, "Photographer reaction could not be mirrored to the topic");
        });
    }

    private async resolveTopic(api: Api, chatId: number, topicId: number): Promise<{ thread: SupportThread; legacyTopicId: number | null } | null> {
        const thread = await this.deps.repo.findByTopic(BigInt(chatId), topicId);
        if (thread) return { thread, legacyTopicId: null };
        const legacyUserId = await this.deps.repo.findLegacyUserByTopic(BigInt(chatId), topicId);
        if (!legacyUserId) return null;
        try {
            return { thread: await this.deps.threads.ensureThread(api, legacyUserId), legacyTopicId: topicId };
        } catch (error) {
            // Стара тема кандидатки чи людини без профілю — нехай її веде старий обробник.
            logger.debug({ err: error, topicId }, "Legacy support topic has no staff thread");
            return null;
        }
    }

    private readonly legacyNoticeDays = new Map<number, string>();

    /** Раз на день у старій темі — де тепер розмова. */
    private async noticeLegacy(api: Api, resolved: { thread: SupportThread; legacyTopicId: number | null }, chatId: number, topicId: number) {
        if (resolved.legacyTopicId === null) return;
        const day = this.deps.now().toISOString().slice(0, 10);
        if (this.legacyNoticeDays.get(topicId) === day) return;
        this.legacyNoticeDays.set(topicId, day);
        await api.sendMessage(chatId, `➡️ This conversation now lives here: ${this.deps.topicLink(resolved.thread.chatId, resolved.thread.topicId)}`, {
            message_thread_id: topicId,
        }).catch(error => logger.warn({ err: error, topicId }, "Legacy topic notice failed"));
    }

    private async sendToStaff(api: Api, thread: SupportThread, chatId: number, staffChatId: number, message: Message): Promise<{ messageId: number; contextText: string | null }> {
        const repliedId = message.reply_to_message?.message_id;
        const isTopicRoot = !repliedId || repliedId === message.message_thread_id || Boolean(message.reply_to_message?.forum_topic_created);
        const link = isTopicRoot ? null : await this.deps.repo.findLinkByTopicMessage(BigInt(chatId), repliedId!);

        if (link?.direction === "CONTEXT" && link.contextText) {
            const prefix = contextQuoteHtml(link.contextText);
            if (message.text !== undefined) {
                const html = prefix + msgToHtml(message.text, message.entities ?? []);
                if (html.length <= TEXT_LIMIT) {
                    const sent = await api.sendMessage(staffChatId, html, { parse_mode: "HTML" });
                    return { messageId: sent.message_id, contextText: link.contextText };
                }
            } else if (canCarryCaption(message)) {
                const caption = prefix + msgToHtml(message.caption ?? "", message.caption_entities ?? []);
                if (caption.length <= CAPTION_LIMIT) {
                    const copied = await api.copyMessage(staffChatId, chatId, message.message_id, { caption, parse_mode: "HTML" });
                    return { messageId: copied.message_id, contextText: link.contextText };
                }
            }
            // Стікер, кружечок, задовгий текст: цитата окремим повідомленням, потім копія як є.
            await api.sendMessage(staffChatId, prefix.trimEnd(), { parse_mode: "HTML" });
            const copied = await api.copyMessage(staffChatId, chatId, message.message_id, {});
            return { messageId: copied.message_id, contextText: null };
        }

        const reply = link && link.privateMessageId && link.privateChatId && Number(link.privateChatId) === staffChatId
            ? withQuote({ message_id: link.privateMessageId, allow_sending_without_reply: true }, message)
            : undefined;
        try {
            const copied = await api.copyMessage(staffChatId, chatId, message.message_id, reply ? { reply_parameters: reply } : {});
            return { messageId: copied.message_id, contextText: null };
        } catch (error) {
            if (!reply?.quote || !isQuoteError(error)) throw error;
            const { quote: _quote, quote_position: _position, ...plain } = reply;
            const copied = await api.copyMessage(staffChatId, chatId, message.message_id, { reply_parameters: plain });
            return { messageId: copied.message_id, contextText: null };
        }
    }

    private async flushSupportAlbum(api: Api, thread: SupportThread, staffChatId: number, sender: { id: number; firstName: string }, items: Message[]) {
        const messages = [...items].sort((a, b) => a.message_id - b.message_id);
        const chatId = this.deps.supportChatId();
        try {
            const copied = await api.copyMessages(staffChatId, chatId, messages.map(item => item.message_id));
            for (let index = 0; index < messages.length && index < copied.length; index++) {
                await this.deps.repo.addLink({
                    threadId: thread.id,
                    direction: "OUT",
                    topicChatId: BigInt(chatId),
                    topicMessageId: messages[index]!.message_id,
                    privateChatId: BigInt(staffChatId),
                    privateMessageId: copied[index]!.message_id,
                });
            }
            await this.afterSupportDelivery(api, thread, sender, messages[0]!);
        } catch (error) {
            await api.sendMessage(chatId, this.deliveryFailureText(thread, error), { message_thread_id: messages[0]!.message_thread_id ?? thread.topicId })
                .catch(noteError => logger.warn({ err: noteError }, "Support album failure note failed"));
        }
    }

    private async afterSupportDelivery(api: Api, thread: SupportThread, sender: { id: number }, message: Message): Promise<SupportThread> {
        const updated = await this.deps.threads.applyStatus(api, thread, { kind: "support_reply", actorTelegramId: BigInt(sender.id) });
        await this.deps.repo.update(updated.id, { lastSupportAt: this.deps.now() });
        await this.deps.timeline(thread.userId, "ADMIN", messagePreview(message), { threadId: thread.id, adminId: sender.id }).catch(error => {
            logger.warn({ err: error, threadId: thread.id }, "Support timeline event failed");
        });
        return updated;
    }

    private deliveryFailureText(thread: SupportThread, error: unknown): string {
        const name = thread.title.split(" · ")[0] ?? "The photographer";
        if (isBlockedError(error)) return `❌ Not delivered: ${name} blocked the bot.`;
        return `❌ Not delivered: ${describeError(error)}`;
    }

    /** Дія в темі; тему видалили руками — нова тема і ще одна спроба. */
    private async onTopic(api: Api, thread: SupportThread, action: (target: SupportThread) => Promise<unknown>): Promise<SupportThread> {
        try {
            await action(thread);
            return thread;
        } catch (error) {
            if (!isTopicGoneError(error)) throw error;
            const recreated = await this.deps.threads.recreateTopic(api, thread);
            await action(recreated);
            return recreated;
        }
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
