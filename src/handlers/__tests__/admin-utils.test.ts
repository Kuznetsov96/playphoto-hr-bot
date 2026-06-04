import { describe, expect, it } from "vitest";
import { htmlToPlainText, msgToHtml } from "../admin/utils.js";

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
