import { describe, expect, it } from "vitest";
import {
    getRichMessageHtml,
    getRichMessageInputText,
    getRichMessagePlainText,
} from "../rich-message.js";

describe("getRichMessageHtml", () => {
    it("converts checklists and key-value tables to stable Telegram HTML", () => {
        expect(getRichMessageHtml({
            blocks: [{
                type: "list",
                items: [{
                    label: "☑",
                    has_checkbox: true,
                    is_checked: true,
                    blocks: [{ type: "paragraph", text: "Ready" }],
                }],
            }, {
                type: "table",
                cells: [[
                    { text: "Name", is_header: true, align: "left", valign: "top" },
                    { text: "Olena", align: "left", valign: "top" },
                ]],
            }],
        })).toBe("☑ Ready\n\n<b>Name:</b> Olena");
    });
});

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

    it("creates labels for outgoing Bot API 10.2 list items", () => {
        expect(getRichMessagePlainText({
            blocks: [{
                type: "list",
                items: [
                    { has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "Profile reviewed" }] },
                    { value: 2, blocks: [{ type: "paragraph", text: "Invite candidate" }] },
                    { blocks: [{ type: "paragraph", text: "Add a note" }] },
                ],
            }],
        })).toBe("[x] Profile reviewed\n2. Invite candidate\n• Add a note");
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
