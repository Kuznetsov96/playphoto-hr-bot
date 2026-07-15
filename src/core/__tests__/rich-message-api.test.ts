import type { Api } from "grammy";
import type { RichText } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import type { InputRichBlock, LatestInputRichMessage } from "../../types/telegram-rich-message.js";
import {
    buildRichMessageUpgrade,
    createLatestRichMessageFromText,
    preserveLegacyHtmlLineBreaks,
    richMessageApiTransformer,
    sendLatestRichMessage,
    sendLatestRichMessageDraft,
} from "../rich-message-api.js";

describe("createLatestRichMessageFromText", () => {
    it("maps existing HTML, rich Markdown, and plain text to rich content", () => {
        expect(createLatestRichMessageFromText("<b>Hello</b>", "HTML"))
            .toEqual({ html: "<b>Hello</b>" });
        expect(createLatestRichMessageFromText("**Hello**", "Markdown"))
            .toEqual({ markdown: "**Hello**" });
        expect(createLatestRichMessageFromText("Hello"))
            .toEqual({ blocks: [{ type: "paragraph", text: "Hello" }] });
    });

    it("keeps MarkdownV2 on the classic API because it is a different grammar", () => {
        expect(createLatestRichMessageFromText("*Hello*", "MarkdownV2")).toBeNull();
    });

    it("preserves legacy HTML line breaks in rich HTML", () => {
        const adminPanel = [
            "🤖 <b>PlayPhoto 2.0 Admin Panel</b>",
            "👥 <b>Team:</b> 88 active",
            "📍 <b>Locations:</b> 19 active",
            "",
            "Choose category:",
        ].join("\n");

        expect(createLatestRichMessageFromText(adminPanel, "HTML")).toEqual({
            html: "🤖 <b>PlayPhoto 2.0 Admin Panel</b><br>👥 <b>Team:</b> 88 active<br>📍 <b>Locations:</b> 19 active<br><br>Choose category:",
        });
    });
});

describe("preserveLegacyHtmlLineBreaks", () => {
    it("normalizes CRLF and leaves preformatted newlines intact", () => {
        expect(preserveLegacyHtmlLineBreaks("Before\r\n<pre>line 1\r\nline 2</pre>\rAfter"))
            .toBe("Before<br><pre>line 1\nline 2</pre><br>After");
    });

    it("supports multiple preformatted blocks", () => {
        expect(preserveLegacyHtmlLineBreaks("A\n<pre>B\nC</pre>\nD\n<pre>E\nF</pre>\nG"))
            .toBe("A<br><pre>B\nC</pre><br>D<br><pre>E\nF</pre><br>G");
    });
});

describe("buildRichMessageUpgrade", () => {
    it("upgrades compatible sendMessage calls without losing delivery options", () => {
        expect(buildRichMessageUpgrade("sendMessage", {
            chat_id: 42,
            text: "<b>Hello</b>",
            parse_mode: "HTML",
            disable_notification: true,
            protect_content: true,
            reply_to_message_id: 7,
            reply_markup: { inline_keyboard: [] },
            link_preview_options: { is_disabled: true },
        })).toEqual({
            method: "sendRichMessage",
            payload: {
                chat_id: 42,
                rich_message: { html: "<b>Hello</b>" },
                disable_notification: true,
                protect_content: true,
                reply_parameters: { message_id: 7 },
                reply_markup: { inline_keyboard: [] },
            },
        });
    });

    it("upgrades compatible editMessageText calls", () => {
        expect(buildRichMessageUpgrade("editMessageText", {
            chat_id: 42,
            message_id: 11,
            text: "Updated",
        })).toEqual({
            method: "editMessageText",
            payload: {
                chat_id: 42,
                message_id: 11,
                rich_message: { blocks: [{ type: "paragraph", text: "Updated" }] },
            },
        });
    });

    it.each([
        ["explicit entities", { entities: [{ type: "bold", offset: 0, length: 1 }] }],
        ["MarkdownV2", { parse_mode: "MarkdownV2" }],
        ["custom previews", { link_preview_options: { url: "https://example.com" } }],
        ["ephemeral receiver", { receiver_user_id: 10 }],
        ["ephemeral callback", { callback_query_id: "callback" }],
    ])("keeps %s on the classic API", (_name, extra) => {
        expect(buildRichMessageUpgrade("sendMessage", {
            chat_id: 42,
            text: "Hello",
            ...extra,
        })).toBeNull();
    });
});

describe("richMessageApiTransformer", () => {
    type Invoke = (
        method: string,
        payload: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<Record<string, unknown>>;

    const transform = richMessageApiTransformer as unknown as (
        prev: Invoke,
        method: string,
        payload: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<Record<string, unknown>>;

    it("sends an upgraded rich request when Telegram accepts it", async () => {
        const response = { ok: true, result: { message_id: 1 } };
        const prev = vi.fn<Invoke>().mockResolvedValue(response);

        await expect(transform(prev, "sendMessage", { chat_id: 42, text: "Hello" }))
            .resolves.toBe(response);
        expect(prev).toHaveBeenCalledOnce();
        expect(prev).toHaveBeenCalledWith("sendRichMessage", {
            chat_id: 42,
            rich_message: { blocks: [{ type: "paragraph", text: "Hello" }] },
        }, undefined);
    });

    it.each([400, 404])("falls back to sendMessage after a Telegram %s response", async (errorCode) => {
        const richError = { ok: false, error_code: errorCode };
        const classicResponse = { ok: true, result: { message_id: 1 } };
        const prev = vi.fn<Invoke>()
            .mockResolvedValueOnce(richError)
            .mockResolvedValueOnce(classicResponse);
        const original = { chat_id: 42, text: "Hello" };

        await expect(transform(prev, "sendMessage", original)).resolves.toBe(classicResponse);
        expect(prev).toHaveBeenNthCalledWith(1, "sendRichMessage", {
            chat_id: 42,
            rich_message: { blocks: [{ type: "paragraph", text: "Hello" }] },
        }, undefined);
        expect(prev).toHaveBeenNthCalledWith(2, "sendMessage", original, undefined);
    });

    it("does not hide server or rate-limit failures behind a second request", async () => {
        const response = { ok: false, error_code: 500 };
        const prev = vi.fn<Invoke>().mockResolvedValue(response);

        await expect(transform(prev, "sendMessage", { chat_id: 42, text: "Hello" }))
            .resolves.toBe(response);
        expect(prev).toHaveBeenCalledOnce();
    });
});

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
        const richMessage: LatestInputRichMessage = { blocks: allFinalBlocks };

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
        const richMessage: LatestInputRichMessage = {
            html: "<img src=\"tg://photo?id=portfolio\">",
            media: [{ id: "portfolio", media: { type: "photo", media: "photo-id" } }],
        };

        await sendLatestRichMessage(api, 42, richMessage);

        expect(sendRichMessageMock).toHaveBeenCalledWith(42, richMessage, undefined);
    });

    it("supports the draft-only thinking block", async () => {
        const sendDraftMock = vi.fn().mockResolvedValue(true);
        const api = { sendRichMessageDraft: sendDraftMock } as unknown as Api;
        const draft: LatestInputRichMessage = {
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
});
