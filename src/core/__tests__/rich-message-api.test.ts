import type { Api } from "grammy";
import type {
    InputRichBlock,
    InputRichMessage,
    InputRichMessageWithoutUpload,
    RichText,
} from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
    editLatestRichInlineMessage,
    editLatestRichMessage,
    sendLatestRichMessage,
    sendLatestRichMessageDraft,
} from "../rich-message-api.js";

describe("Bot API 10.2 rich-message senders", () => {
    const allRichText: RichText = [
        "plain",
        { type: "bold", text: "bold" },
        { type: "italic", text: "italic" },
        { type: "underline", text: "underline" },
        { type: "strikethrough", text: "strikethrough" },
        { type: "spoiler", text: "spoiler" },
        { type: "date_time", text: "today", unix_time: 1_700_000_000, date_time_format: "wDT" },
        {
            type: "text_mention",
            text: "Olena",
            user: { id: 7, is_bot: false, first_name: "Olena" },
        },
        { type: "subscript", text: "subscript" },
        { type: "superscript", text: "superscript" },
        { type: "marked", text: "marked" },
        { type: "code", text: "code" },
        { type: "custom_emoji", custom_emoji_id: "emoji-id", alternative_text: "✅" },
        { type: "mathematical_expression", expression: "x^2" },
        { type: "url", text: "Telegram", url: "https://telegram.org" },
        { type: "email_address", text: "Mail", email_address: "team@example.com" },
        { type: "phone_number", text: "Call", phone_number: "+380000000000" },
        { type: "bank_card_number", text: "Card", bank_card_number: "4242424242424242" },
        { type: "mention", text: "@playphoto", username: "playphoto" },
        { type: "hashtag", text: "#hiring", hashtag: "hiring" },
        { type: "cashtag", text: "$USD", cashtag: "USD" },
        { type: "bot_command", text: "/start", bot_command: "start" },
        { type: "anchor", name: "top" },
        { type: "anchor_link", text: "Back", anchor_name: "top" },
        { type: "reference", text: "Reference body", name: "note" },
        { type: "reference_link", text: "[1]", reference_name: "note" },
    ];

    const mediaBlocks: InputRichBlock[] = [
        { type: "animation", animation: { type: "animation", media: "animation-id" }, caption: { text: "Animation" } },
        { type: "audio", audio: { type: "audio", media: "audio-id" }, caption: { text: "Audio" } },
        { type: "photo", photo: { type: "photo", media: "photo-id" }, caption: { text: "Photo" } },
        { type: "video", video: { type: "video", media: "video-id" }, caption: { text: "Video" } },
        { type: "voice_note", voice_note: { type: "voice_note", media: "voice-id" }, caption: { text: "Voice" } },
    ];

    const allFinalBlocks: InputRichBlock[] = [
        { type: "paragraph", text: allRichText },
        { type: "heading", size: 1, text: "Heading" },
        { type: "pre", text: "const ready = true;", language: "typescript" },
        { type: "footer", text: "Footer" },
        { type: "divider" },
        { type: "mathematical_expression", expression: "E=mc^2" },
        { type: "anchor", name: "section" },
        {
            type: "list",
            items: [{ blocks: [{ type: "paragraph", text: "Checked" }], has_checkbox: true, is_checked: true }],
        },
        {
            type: "blockquote",
            blocks: [{ type: "paragraph", text: "Quote" }],
            credit: "Author",
        },
        { type: "pullquote", text: "Pull quote", credit: "Author" },
        { type: "collage", blocks: mediaBlocks.slice(0, 2), caption: { text: "Collage" } },
        { type: "slideshow", blocks: mediaBlocks.slice(2), caption: { text: "Slideshow" } },
        {
            type: "table",
            cells: [[
                { text: "Name", is_header: true, align: "left", valign: "top" },
                { text: "Olena", align: "left", valign: "top" },
            ]],
            is_bordered: true,
            is_striped: true,
            caption: "Candidates",
        },
        {
            type: "details",
            summary: "More",
            blocks: [{ type: "paragraph", text: "Details" }],
            is_open: true,
        },
        {
            type: "map",
            location: { latitude: 50.4501, longitude: 30.5234 },
            zoom: 14,
            width: 640,
            height: 360,
            caption: { text: "Kyiv" },
        },
        ...mediaBlocks,
    ];

    it("passes every explicit rich text and final block type to sendRichMessage", async () => {
        const sendRichMessageMock = vi.fn().mockResolvedValue({ message_id: 1 });
        const api = { sendRichMessage: sendRichMessageMock } as unknown as Api;
        const richMessage: InputRichMessage = { blocks: allFinalBlocks };

        await sendLatestRichMessage(api, 42, richMessage, { disable_notification: true });

        expect(sendRichMessageMock).toHaveBeenCalledWith(
            42,
            richMessage,
            { disable_notification: true },
        );
    });

    it("supports HTML/Markdown embedded media introduced in Bot API 10.2", async () => {
        const sendRichMessageMock = vi.fn().mockResolvedValue({ message_id: 1 });
        const api = { sendRichMessage: sendRichMessageMock } as unknown as Api;
        const richMessage: InputRichMessage = {
            html: "<img src=\"tg://photo?id=portfolio\">",
            media: [{ id: "portfolio", media: { type: "photo", media: "photo-id" } }],
        };

        await sendLatestRichMessage(api, 42, richMessage);

        expect(sendRichMessageMock).toHaveBeenCalledWith(42, richMessage, undefined);
    });

    it("supports the draft-only thinking block", async () => {
        const sendDraftMock = vi.fn().mockResolvedValue(true);
        const api = { sendRichMessageDraft: sendDraftMock } as unknown as Api;
        const draft: InputRichMessageWithoutUpload = {
            blocks: [{ type: "thinking", text: "Analyzing candidates…" }],
        };

        await sendLatestRichMessageDraft(api, 42, 99, draft, { message_thread_id: 5 });

        expect(sendDraftMock).toHaveBeenCalledWith(
            42,
            99,
            draft,
            { message_thread_id: 5 },
        );
    });

    it("edits a message as rich content only when explicitly requested", async () => {
        const editMessageTextMock = vi.fn().mockResolvedValue({ message_id: 1 });
        const api = { editMessageText: editMessageTextMock } as unknown as Api;
        const richMessage: InputRichMessage = {
            blocks: [{ type: "heading", size: 2, text: "Updated report" }],
        };

        await editLatestRichMessage(api, 42, 7, richMessage, {
            reply_markup: { inline_keyboard: [] },
        });

        expect(editMessageTextMock).toHaveBeenCalledWith(
            42,
            7,
            richMessage,
            { reply_markup: { inline_keyboard: [] } },
        );
    });

    it("edits inline rich content only when explicitly requested", async () => {
        const editInlineMock = vi.fn().mockResolvedValue(true);
        const api = { editMessageTextInline: editInlineMock } as unknown as Api;
        const richMessage: InputRichMessage = { markdown: "# Updated report" };

        await editLatestRichInlineMessage(api, "inline-id", richMessage);

        expect(editInlineMock).toHaveBeenCalledWith("inline-id", richMessage, undefined);
    });
});
