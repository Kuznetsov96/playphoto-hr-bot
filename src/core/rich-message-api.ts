import type { Api } from "grammy";
import type { InputRichMessage, InputRichMessageWithoutUpload } from "grammy/types";

// Rich output is deliberately opt-in. Existing menus and notifications keep
// using classic sendMessage/editMessageText typography and newline semantics.
type SendRichOptions = Parameters<Api["sendRichMessage"]>[2];
type SendRichDraftOptions = Parameters<Api["sendRichMessageDraft"]>[3];
type EditRichOptions = Parameters<Api["editMessageText"]>[3];
type EditInlineRichOptions = Parameters<Api["editMessageTextInline"]>[2];

/** Sends Bot API 10.2 rich content, including explicit blocks and embedded media. */
export function sendLatestRichMessage(
    api: Api,
    chatId: number | string,
    richMessage: InputRichMessage,
    options?: SendRichOptions,
) {
    return api.sendRichMessage(chatId, richMessage, options);
}

/** Supports streamed drafts, including the draft-only thinking block. */
export function sendLatestRichMessageDraft(
    api: Api,
    chatId: number,
    draftId: number,
    richMessage: InputRichMessageWithoutUpload,
    options?: SendRichDraftOptions,
) {
    return api.sendRichMessageDraft(chatId, draftId, richMessage, options);
}

/** Explicitly replaces a classic or rich message with Bot API 10.2 rich content. */
export function editLatestRichMessage(
    api: Api,
    chatId: number | string,
    messageId: number,
    richMessage: InputRichMessage,
    options?: EditRichOptions,
) {
    return api.editMessageText(chatId, messageId, richMessage, options);
}

/** Explicitly edits an inline message using Bot API 10.2 rich content. */
export function editLatestRichInlineMessage(
    api: Api,
    inlineMessageId: string,
    richMessage: InputRichMessage,
    options?: EditInlineRichOptions,
) {
    return api.editMessageTextInline(inlineMessageId, richMessage, options);
}
