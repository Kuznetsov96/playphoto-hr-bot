import { describe, expect, it } from "vitest";
import { getRichMessagePlainText } from "../rich-message.js";

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
