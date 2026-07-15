import type { InputRichMessage, RichBlock, RichBlockCaption, RichMessage, RichText } from "grammy/types";

const DEFAULT_PREVIEW_LIMIT = 1_000;
const MAX_RICH_MESSAGE_TEXT_LENGTH = 32_768;

interface PlainTextOptions {
    includeMediaLabels: boolean;
}

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

function blocksToPlainText(blocks: RichBlock[], options: PlainTextOptions): string {
    return blocks.map(block => blockToPlainText(block, options)).filter(Boolean).join("\n");
}

function blockToPlainText(block: RichBlock, options: PlainTextOptions): string {
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
                .map(item => `${item.label} ${blocksToPlainText(item.blocks, options)}`.trim())
                .join("\n");
        case "blockquote":
            return [blocksToPlainText(block.blocks, options), block.credit ? richTextToPlainText(block.credit) : ""]
                .filter(Boolean)
                .join(" — ");
        case "collage":
        case "slideshow":
            return [blocksToPlainText(block.blocks, options), captionToPlainText(block.caption)]
                .filter(Boolean)
                .join("\n");
        case "table": {
            const rows = block.cells.map(row => row
                .map(cell => cell.text ? richTextToPlainText(cell.text) : "")
                .join(" | "))
                .filter(row => row.replaceAll("|", "").trim().length > 0);
            const caption = block.caption ? richTextToPlainText(block.caption) : "";
            return [caption, ...rows].filter(Boolean).join("\n");
        }
        case "details":
            return [richTextToPlainText(block.summary), blocksToPlainText(block.blocks, options)]
                .filter(Boolean)
                .join("\n");
        case "map":
            return [options.includeMediaLabels ? "[Map]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "animation":
            return [options.includeMediaLabels ? "[Animation]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "audio":
            return [options.includeMediaLabels ? "[Audio]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "photo":
            return [options.includeMediaLabels ? "[Photo]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "video":
            return [options.includeMediaLabels ? "[Video]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
        case "voice_note":
            return [options.includeMediaLabels ? "[Voice note]" : "", captionToPlainText(block.caption)].filter(Boolean).join(" ");
    }
}

function normalizeAndLimitPlainText(source: string, maxLength: number): string {
    const plainText = source
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (plainText.length <= maxLength) return plainText;
    return `${plainText.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function getRichMessagePlainText(
    richMessage?: RichMessage | InputRichMessage,
    maxLength = DEFAULT_PREVIEW_LIMIT,
): string {
    if (!richMessage) return "";

    const source = "blocks" in richMessage
        ? blocksToPlainText(richMessage.blocks, { includeMediaLabels: true })
        : richMessage.markdown || richMessage.html || "";
    return normalizeAndLimitPlainText(source, maxLength);
}

/**
 * Extracts semantic user input from an incoming rich message. Pure media
 * blocks don't become fake form values, while their captions remain usable.
 */
export function getRichMessageInputText(
    richMessage?: RichMessage,
    maxLength = MAX_RICH_MESSAGE_TEXT_LENGTH,
): string {
    if (!richMessage) return "";
    return normalizeAndLimitPlainText(
        blocksToPlainText(richMessage.blocks, { includeMediaLabels: false }),
        maxLength,
    );
}
