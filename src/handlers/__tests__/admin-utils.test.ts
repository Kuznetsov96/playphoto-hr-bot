import { describe, expect, it } from "vitest";
import { msgToHtml } from "../admin/utils.js";

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
});
