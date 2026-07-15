import type { Api } from "grammy";
import type { InputRichMessage } from "grammy/types";
import type { LatestInputRichMessage } from "../types/telegram-rich-message.js";

// Rich output is deliberately opt-in. Existing menus and notifications keep
// using classic sendMessage/editMessageText typography and newline semantics.
type SendRichOptions = Parameters<Api["sendRichMessage"]>[2];
type SendRichDraftOptions = Parameters<Api["sendRichMessageDraft"]>[3];
type EditRichOptions = Parameters<Api["editMessageText"]>[3];
type EditInlineRichOptions = Parameters<Api["editMessageTextInline"]>[2];

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

/** Explicitly replaces a classic or rich message with Bot API 10.2 rich content. */
export function editLatestRichMessage(
    api: Api,
    chatId: number | string,
    messageId: number,
    richMessage: LatestInputRichMessage,
    options?: EditRichOptions,
) {
    return api.editMessageText(chatId, messageId, richMessage as InputRichMessage, options);
}

/** Explicitly edits an inline message using Bot API 10.2 rich content. */
export function editLatestRichInlineMessage(
    api: Api,
    inlineMessageId: string,
    richMessage: LatestInputRichMessage,
    options?: EditInlineRichOptions,
) {
    return api.editMessageTextInline(inlineMessageId, richMessage as InputRichMessage, options);
}
