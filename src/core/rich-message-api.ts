import { Bot, type Api, type Transformer } from "grammy";
import type { InputRichMessage, ParseMode } from "grammy/types";
import type { LatestInputRichMessage } from "../types/telegram-rich-message.js";

type ApiEnvelope = {
    ok: boolean;
    error_code?: number;
};

type UpgradedCall = {
    method: "sendRichMessage" | "editMessageText";
    payload: Record<string, unknown>;
};

const SEND_RICH_FIELDS = [
    "business_connection_id",
    "chat_id",
    "message_thread_id",
    "direct_messages_topic_id",
    "disable_notification",
    "protect_content",
    "allow_paid_broadcast",
    "message_effect_id",
    "suggested_post_parameters",
    "reply_parameters",
    "reply_markup",
] as const;

const EDIT_RICH_FIELDS = [
    "business_connection_id",
    "chat_id",
    "message_id",
    "inline_message_id",
    "reply_markup",
] as const;

function copyDefinedFields(
    source: Record<string, unknown>,
    target: Record<string, unknown>,
    fields: readonly string[],
) {
    for (const field of fields) {
        if (source[field] !== undefined) target[field] = source[field];
    }
}

function hasUnsupportedPreviewOptions(payload: Record<string, any>): boolean {
    const options = payload.link_preview_options;
    if (!options) return false;

    const keys = Object.keys(options);
    return keys.some(key => key !== "is_disabled") || options.is_disabled !== true;
}

/**
 * Classic Bot API HTML treats raw newlines as visible line breaks, while rich
 * HTML follows document whitespace rules and requires explicit <br> tags.
 * Preserve legacy layout without changing whitespace inside <pre> blocks.
 */
export function preserveLegacyHtmlLineBreaks(html: string): string {
    const normalized = html.replace(/\r\n?/g, "\n");
    const preBlockPattern = /<pre(?:\s[^>]*)?>[\s\S]*?<\/pre>/gi;
    let result = "";
    let cursor = 0;

    for (const match of normalized.matchAll(preBlockPattern)) {
        const index = match.index;
        result += normalized.slice(cursor, index).replaceAll("\n", "<br>");
        result += match[0];
        cursor = index + match[0].length;
    }

    return result + normalized.slice(cursor).replaceAll("\n", "<br>");
}

export function createLatestRichMessageFromText(
    text: string,
    parseMode?: ParseMode,
): LatestInputRichMessage | null {
    if (parseMode === "HTML") return { html: preserveLegacyHtmlLineBreaks(text) };
    if (parseMode === "Markdown") return { markdown: text };
    if (parseMode === "MarkdownV2") return null;
    if (parseMode !== undefined) return null;
    return { blocks: [{ type: "paragraph", text }] };
}

export function buildRichMessageUpgrade(
    method: string,
    rawPayload: unknown,
): UpgradedCall | null {
    if (method !== "sendMessage" && method !== "editMessageText") return null;

    const payload = rawPayload as Record<string, any>;
    if (typeof payload.text !== "string" || payload.text.length === 0) return null;
    if (Array.isArray(payload.entities) && payload.entities.length > 0) return null;
    if (payload.receiver_user_id !== undefined || payload.callback_query_id !== undefined) return null;
    if (hasUnsupportedPreviewOptions(payload)) return null;

    const richMessage = createLatestRichMessageFromText(payload.text, payload.parse_mode);
    if (!richMessage) return null;

    const upgradedPayload: Record<string, unknown> = {
        rich_message: richMessage,
    };

    if (method === "sendMessage") {
        copyDefinedFields(payload, upgradedPayload, SEND_RICH_FIELDS);
        if (upgradedPayload.reply_parameters === undefined && payload.reply_to_message_id !== undefined) {
            upgradedPayload.reply_parameters = { message_id: payload.reply_to_message_id };
        }
        return { method: "sendRichMessage", payload: upgradedPayload };
    }

    copyDefinedFields(payload, upgradedPayload, EDIT_RICH_FIELDS);
    return { method: "editMessageText", payload: upgradedPayload };
}

function shouldUseClassicFallback(response: ApiEnvelope): boolean {
    return !response.ok && (response.error_code === 400 || response.error_code === 404);
}

/**
 * Transparently upgrades compatible sendMessage/editMessageText calls to rich
 * messages. Telegram-rejected rich payloads fall back to the original call.
 */
export const richMessageApiTransformer: Transformer = async (prev, method, payload, signal) => {
    const upgraded = buildRichMessageUpgrade(method, payload);
    if (!upgraded) return prev(method, payload, signal);

    const invoke = prev as unknown as (
        method: string,
        payload: Record<string, unknown>,
        signal?: unknown,
    ) => Promise<ApiEnvelope>;
    const response = await invoke(upgraded.method, upgraded.payload, signal);

    if (shouldUseClassicFallback(response)) {
        return prev(method, payload, signal);
    }

    return response as never;
};

const configuredApis = new WeakSet<Api>();

/** Installs rich-message upgrading once on any Api instance. */
export function configureRichMessageApi<T extends Api>(api: T): T {
    const config = (api as Api | undefined)?.config;
    if (!config || typeof config.use !== "function") return api;

    if (!configuredApis.has(api)) {
        config.use(richMessageApiTransformer);
        configuredApis.add(api);
    }
    return api;
}

/** Creates a standalone Bot whose outgoing text also uses the rich API. */
export function createRichMessageBot(token: string): Bot {
    const bot = new Bot(token);
    configureRichMessageApi(bot.api);
    return bot;
}

type SendRichOptions = Parameters<Api["sendRichMessage"]>[2];
type SendRichDraftOptions = Parameters<Api["sendRichMessageDraft"]>[3];

/** Bot API 10.2-compatible sender, including explicit blocks and embedded media. */
export function sendLatestRichMessage(
    api: Api,
    chatId: number | string,
    richMessage: LatestInputRichMessage,
    options?: SendRichOptions,
) {
    return api.sendRichMessage(chatId, richMessage as InputRichMessage, options);
}

/** Supports streamed drafts, including the draft-only thinking block. */
export function sendLatestRichMessageDraft(
    api: Api,
    chatId: number,
    draftId: number,
    richMessage: LatestInputRichMessage,
    options?: SendRichDraftOptions,
) {
    return api.sendRichMessageDraft(chatId, draftId, richMessage as InputRichMessage, options);
}
