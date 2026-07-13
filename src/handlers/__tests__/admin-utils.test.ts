import { describe, expect, it, vi } from "vitest";
import { htmlToPlainText, msgToHtml, sendAdminOutboundMessage } from "../admin/utils.js";

describe("msgToHtml", () => {
    it("keeps nested Telegram entities valid when they start at the same offset", () => {
        const html = msgToHtml("Hello world", [
            { type: "bold", offset: 0, length: 5 },
            { type: "underline", offset: 0, length: 11 },
        ]);

        expect(html).toBe("<u><b>Hello</b> world</u>");
    });

    it("keeps nested Telegram entities valid when they end at the same offset", () => {
        const html = msgToHtml("Hello world", [
            { type: "bold", offset: 0, length: 11 },
            { type: "underline", offset: 6, length: 5 },
        ]);

        expect(html).toBe("<b>Hello <u>world</u></b>");
    });

    it("normalizes crossing Telegram entities into valid HTML", () => {
        const html = msgToHtml("abcdefg", [
            { type: "underline", offset: 0, length: 5 },
            { type: "bold", offset: 2, length: 5 },
        ]);

        expect(html).toBe("<u>ab<b>cde</b></u><b>fg</b>");
    });

    it("escapes text link URLs inside HTML attributes", () => {
        const html = msgToHtml("Open", [
            { type: "text_link", offset: 0, length: 4, url: 'https://example.com/?a=1&b="<x>"' },
        ]);

        expect(html).toBe('<a href="https://example.com/?a=1&amp;b=&quot;&lt;x&gt;&quot;">Open</a>');
    });
});

describe("htmlToPlainText", () => {
    it("removes Telegram HTML formatting from stored task previews", () => {
        const text = htmlToPlainText(
            "<b>Привіт!</b> <u>Перед початком зміни</u>\n\n<blockquote>1. основи\n2. скельця</blockquote>",
        );

        expect(text).toBe("Привіт! Перед початком зміни\n\n1. основи\n2. скельця");
    });

    it("decodes escaped user text after stripping tags", () => {
        const text = htmlToPlainText("Порахуй &lt;10&gt; магнітів &amp; напиши \"готово\"");

        expect(text).toBe("Порахуй <10> магнітів & напиши \"готово\"");
    });
});

describe("sendAdminOutboundMessage", () => {
    it("copies media with short captions unchanged", async () => {
        const replyMarkup = { inline_keyboard: [[{ text: "Reply", callback_data: "reply" }]] };
        const ctx = {
            chat: { id: 555 },
            message: {
                message_id: 77,
                caption: "Short caption",
                caption_entities: [],
                photo: [{ file_id: "photo-1" }],
            },
            api: {
                copyMessage: vi.fn().mockResolvedValue({}),
                sendMessage: vi.fn().mockResolvedValue({}),
            },
        };

        await sendAdminOutboundMessage(ctx as any, 123, {
            messageThreadId: 9,
            replyMarkup: replyMarkup as any,
        });

        expect(ctx.api.copyMessage).toHaveBeenCalledWith(123, 555, 77, {
            message_thread_id: 9,
            reply_markup: replyMarkup,
        });
        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    });

    it("splits media with long captions into media plus text message", async () => {
        const replyMarkup = { inline_keyboard: [[{ text: "Reply", callback_data: "reply" }]] };
        const longCaption = `Intro <tag>\n${"а".repeat(1100)}`;
        const ctx = {
            chat: { id: 555 },
            message: {
                message_id: 77,
                caption: longCaption,
                caption_entities: [],
                photo: [{ file_id: "photo-1" }],
            },
            api: {
                copyMessage: vi.fn().mockResolvedValue({}),
                sendMessage: vi.fn().mockResolvedValue({}),
            },
        };

        await sendAdminOutboundMessage(ctx as any, 123, {
            messageThreadId: 9,
            replyMarkup: replyMarkup as any,
        });

        expect(ctx.api.copyMessage).toHaveBeenCalledWith(123, 555, 77, {
            message_thread_id: 9,
            caption: "",
        });
        expect(ctx.api.sendMessage).toHaveBeenCalledWith(
            123,
            `Intro &lt;tag&gt;\n${"а".repeat(1100)}`,
            {
                parse_mode: "HTML",
                message_thread_id: 9,
                reply_markup: replyMarkup,
            },
        );
    });

    it("splits long text-only messages and keeps reply markup on the last chunk", async () => {
        const replyMarkup = { inline_keyboard: [[{ text: "Reply", callback_data: "reply" }]] };
        const longText = `${"а".repeat(3000)}\n${"б".repeat(1800)}`;
        const ctx = {
            chat: { id: 555 },
            message: {
                message_id: 77,
                text: longText,
                entities: [],
            },
            api: {
                copyMessage: vi.fn().mockResolvedValue({}),
                sendMessage: vi.fn().mockResolvedValue({}),
            },
        };

        await sendAdminOutboundMessage(ctx as any, 123, {
            replyMarkup: replyMarkup as any,
            prefixText: false,
        });

        expect(ctx.api.copyMessage).not.toHaveBeenCalled();
        expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
        expect(ctx.api.sendMessage).toHaveBeenNthCalledWith(
            1,
            123,
            "а".repeat(3000),
            { parse_mode: "HTML" },
        );
        expect(ctx.api.sendMessage).toHaveBeenNthCalledWith(
            2,
            123,
            "б".repeat(1800),
            {
                parse_mode: "HTML",
                reply_markup: replyMarkup,
            },
        );
    });
});
