import { describe, expect, it } from "vitest";
import { getRichMessageInputText, getRichMessagePlainText } from "../rich-message.js";

describe("getRichMessagePlainText", () => {
    it("extracts a readable preview from nested rich blocks", () => {
        const preview = getRichMessagePlainText({
            blocks: [
                {
                    type: "heading",
                    size: 2,
                    text: { type: "bold", text: "Weekly report" },
                },
                {
                    type: "list",
                    items: [
                        {
                            label: "•",
                            blocks: [{ type: "paragraph", text: ["Done ", { type: "custom_emoji", custom_emoji_id: "1", alternative_text: "✅" }] }],
                        },
                    ],
                },
                {
                    type: "table",
                    cells: [[
                        { text: "Location", align: "left", valign: "top" },
                        { text: "Kyiv", align: "left", valign: "top" },
                    ]],
                },
                {
                    type: "photo",
                    photo: [],
                    caption: { text: "Entrance" },
                },
            ],
        });

        expect(preview).toBe("Weekly report\n• Done ✅\nLocation | Kyiv\n[Photo] Entrance");
    });

    it("supports outgoing markdown/html payloads and applies the preview limit", () => {
        expect(getRichMessagePlainText({ markdown: "# A report" })).toBe("# A report");
        expect(getRichMessagePlainText({ html: "<h1>A report</h1>" }, 10)).toBe("<h1>A rep…");
    });
});

describe("getRichMessageInputText", () => {
    it("extracts semantic text from every nested text container", () => {
        expect(getRichMessageInputText({
            blocks: [
                { type: "paragraph", text: ["Name: ", { type: "bold", text: "Olena" }] },
                {
                    type: "blockquote",
                    blocks: [{ type: "paragraph", text: "Available tomorrow" }],
                    credit: "Candidate",
                },
                {
                    type: "details",
                    summary: "Contacts",
                    blocks: [{ type: "paragraph", text: "@olena" }],
                },
            ],
        })).toBe("Name: Olena\nAvailable tomorrow — Candidate\nContacts\n@olena");
    });

    it("does not turn a pure media block into a fake form value", () => {
        expect(getRichMessageInputText({
            blocks: [{ type: "photo", photo: [] }],
        })).toBe("");
    });

    it("keeps media captions as form input", () => {
        expect(getRichMessageInputText({
            blocks: [{
                type: "photo",
                photo: [],
                caption: { text: { type: "italic", text: "Portfolio cover" } },
            }],
        })).toBe("Portfolio cover");
    });

    it("uses the rich-message text limit instead of the log preview limit", () => {
        const text = "a".repeat(1_500);
        expect(getRichMessageInputText({
            blocks: [{ type: "paragraph", text }],
        })).toBe(text);
    });
});
