import type { InputRichMessage, RichBlock, RichBlockCaption, RichMessage, RichText } from "grammy/types";

const DEFAULT_PREVIEW_LIMIT = 1_000;

function richTextToPlainText(text: RichText): string {
    if (typeof text === "string") return text;
    if (Array.isArray(text)) return text.map(richTextToPlainText).join("");

    switch (text.type) {
        case "custom_emoji":
            return text.alternative_text;
        case "mathematical_expression":
            return text.expression;
        case "anchor":
            return "";
        default:
            return richTextToPlainText(text.text);
    }
}

function captionToPlainText(caption?: RichBlockCaption): string {
    if (!caption) return "";
    const text = richTextToPlainText(caption.text);
    const credit = caption.credit ? richTextToPlainText(caption.credit) : "";
    return [text, credit].filter(Boolean).join(" — ");
}

function blocksToPlainText(blocks: RichBlock[]): string {
    return blocks.map(blockToPlainText).filter(Boolean).join("\n");
}

function blockToPlainText(block: RichBlock): string {
    switch (block.type) {
        case "paragraph":
        case "heading":
        case "pre":
        case "footer":
        case "pullquote":
        case "thinking":
            return richTextToPlainText(block.text);
        case "divider":
            return "—";
        case "mathematical_expression":
            return block.expression;
        case "anchor":
            return "";
        case "list":
            return block.items
                .map(item => `${item.label} ${blocksToPlainText(item.blocks)}`.trim())
                .join("\n");
        case "blockquote":
            return [blocksToPlainText(block.blocks), block.credit ? richTextToPlainText(block.credit) : ""]
                .filter(Boolean)
                .join(" — ");
        case "collage":
        case "slideshow":
            return [blocksToPlainText(block.blocks), captionToPlainText(block.caption)]
                .filter(Boolean)
                .join("\n");
        case "table": {
            const rows = block.cells.map(row => row
                .map(cell => cell.text ? richTextToPlainText(cell.text) : "")
                .join(" | "));
            const caption = block.caption ? richTextToPlainText(block.caption) : "";
            return [caption, ...rows].filter(Boolean).join("\n");
        }
        case "details":
            return [richTextToPlainText(block.summary), blocksToPlainText(block.blocks)]
                .filter(Boolean)
                .join("\n");
        case "map":
            return ["[Map]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "animation":
            return ["[Animation]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "audio":
            return ["[Audio]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "photo":
            return ["[Photo]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "video":
            return ["[Video]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "voice_note":
            return ["[Voice note]", captionToPlainText(block.caption)].filter(Boolean).join(" ");
    }
}

export function getRichMessagePlainText(
    richMessage?: RichMessage | InputRichMessage,
    maxLength = DEFAULT_PREVIEW_LIMIT,
): string {
    if (!richMessage) return "";

    const source = "blocks" in richMessage
        ? blocksToPlainText(richMessage.blocks)
        : richMessage.markdown || richMessage.html || "";
    const plainText = source
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (plainText.length <= maxLength) return plainText;
    return `${plainText.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
