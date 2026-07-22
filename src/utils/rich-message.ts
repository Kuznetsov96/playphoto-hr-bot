import type {
    InputRichBlock,
    InputRichMessage,
    RichBlock,
    RichBlockCaption,
    RichMessage,
    RichText,
} from "grammy/types";

const DEFAULT_PREVIEW_LIMIT = 1_000;
const MAX_RICH_MESSAGE_TEXT_LENGTH = 32_768;

interface PlainTextOptions {
    includeMediaLabels: boolean;
}

export type RichMessageMediaItem = {
    type: "photo" | "video" | "voice" | "audio" | "animation";
    fileId: string;
};

function collectRichMessageMedia(blocks: RichBlock[], output: RichMessageMediaItem[]): void {
    for (const block of blocks) {
        switch (block.type) {
            case "photo": {
                const photo = block.photo[block.photo.length - 1];
                if (photo?.file_id) output.push({ type: "photo", fileId: photo.file_id });
                break;
            }
            case "video":
                output.push({ type: "video", fileId: block.video.file_id });
                break;
            case "voice_note":
                output.push({ type: "voice", fileId: block.voice_note.file_id });
                break;
            case "audio":
                output.push({ type: "audio", fileId: block.audio.file_id });
                break;
            case "animation":
                output.push({ type: "animation", fileId: block.animation.file_id });
                break;
            case "blockquote":
            case "details":
            case "collage":
            case "slideshow":
                collectRichMessageMedia(block.blocks, output);
                break;
        }
    }
}

export function getRichMessageMedia(richMessage?: RichMessage): RichMessageMediaItem[] {
    if (!richMessage) return [];
    const media: RichMessageMediaItem[] = [];
    collectRichMessageMedia(richMessage.blocks, media);
    return media;
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

function blocksToPlainText(blocks: Array<RichBlock | InputRichBlock>, options: PlainTextOptions): string {
    return blocks.map(block => blockToPlainText(block, options)).filter(Boolean).join("\n");
}

function blockToPlainText(block: RichBlock | InputRichBlock, options: PlainTextOptions): string {
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
                .map(item => {
                    const label = "label" in item
                        ? item.label
                        : item.has_checkbox
                            ? (item.is_checked ? "[x]" : "[ ]")
                            : item.value !== undefined
                                ? `${item.value}.`
                                : "•";
                    return `${label} ${blocksToPlainText(item.blocks, options)}`.trim();
                })
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

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
    return escapeHtml(text).replace(/"/g, "&quot;");
}

function richTextToHtml(text: RichText): string {
    if (typeof text === "string") return escapeHtml(text);
    if (Array.isArray(text)) return text.map(richTextToHtml).join("");

    switch (text.type) {
        case "bold":
            return `<b>${richTextToHtml(text.text)}</b>`;
        case "italic":
            return `<i>${richTextToHtml(text.text)}</i>`;
        case "underline":
            return `<u>${richTextToHtml(text.text)}</u>`;
        case "strikethrough":
            return `<s>${richTextToHtml(text.text)}</s>`;
        case "spoiler":
            return `<tg-spoiler>${richTextToHtml(text.text)}</tg-spoiler>`;
        case "code":
            return `<code>${escapeHtml(richTextToPlainText(text.text))}</code>`;
        case "url":
            return `<a href="${escapeHtmlAttribute(text.url)}">${richTextToHtml(text.text)}</a>`;
        case "email_address":
            return `<a href="mailto:${escapeHtmlAttribute(text.email_address)}">${richTextToHtml(text.text)}</a>`;
        case "phone_number":
            return `<a href="tel:${escapeHtmlAttribute(text.phone_number)}">${richTextToHtml(text.text)}</a>`;
        case "text_mention":
            return `<a href="tg://user?id=${text.user.id}">${richTextToHtml(text.text)}</a>`;
        case "custom_emoji":
            return escapeHtml(text.alternative_text);
        case "mathematical_expression":
            return `<code>${escapeHtml(text.expression)}</code>`;
        case "anchor":
            return "";
        default:
            return richTextToHtml(text.text);
    }
}

function captionToHtml(caption?: RichBlockCaption): string {
    if (!caption) return "";
    const text = richTextToHtml(caption.text);
    const credit = caption.credit ? `<i>${richTextToHtml(caption.credit)}</i>` : "";
    return [text, credit].filter(Boolean).join(" — ");
}

function blocksToHtml(blocks: RichBlock[]): string {
    return blocks.map(blockToHtml).filter(Boolean).join("\n\n");
}

function tableToHtml(block: Extract<RichBlock, { type: "table" }>): string {
    const rows = block.cells.filter(row => row.some(cell => cell.text && richTextToPlainText(cell.text).trim()));
    if (rows.length === 0) return block.caption ? richTextToHtml(block.caption) : "";

    const keyValueRows = rows.every(row => row[0]?.is_header && row.length > 1);
    if (keyValueRows) {
        const caption = block.caption ? richTextToHtml(block.caption) : "";
        return [
            caption ? `<b>${caption}</b>` : "",
            ...rows.map(row => {
                const [label, ...values] = row;
                const labelText = label?.text ? richTextToHtml(label.text) : "";
                return `<b>${labelText}:</b> ${values.map(cell => cell.text ? richTextToHtml(cell.text) : "").join(" — ")}`;
            }),
        ].filter(Boolean).join("\n");
    }

    const firstRowIsHeader = rows[0]?.every(cell => cell.is_header) ?? false;
    const headers = firstRowIsHeader
        ? rows[0]!.map(cell => cell.text ? richTextToPlainText(cell.text).trim() : "")
        : [];
    const dataRows = firstRowIsHeader ? rows.slice(1) : rows;
    const renderedRows = dataRows.map(row => {
        if (headers.length > 0) {
            return row.map((cell, index) => {
                const value = cell.text ? richTextToHtml(cell.text) : "";
                const header = headers[index];
                return header ? `<b>${escapeHtml(header)}:</b> ${value}` : value;
            }).filter(Boolean).join("\n");
        }
        return `• ${row.map(cell => cell.text ? richTextToHtml(cell.text) : "").filter(Boolean).join(" — ")}`;
    });
    const caption = block.caption ? richTextToHtml(block.caption) : "";
    return [caption ? `<b>${caption}</b>` : "", ...renderedRows].filter(Boolean).join("\n\n");
}

function blockToHtml(block: RichBlock): string {
    switch (block.type) {
        case "paragraph":
        case "thinking":
            return richTextToHtml(block.text);
        case "heading":
            return `<b>${richTextToHtml(block.text)}</b>`;
        case "pre":
            return `<pre>${escapeHtml(richTextToPlainText(block.text))}</pre>`;
        case "footer":
            return `<i>${richTextToHtml(block.text)}</i>`;
        case "pullquote":
            return `<blockquote>${richTextToHtml(block.text)}</blockquote>`;
        case "divider":
            return "──────────";
        case "mathematical_expression":
            return `<pre>${escapeHtml(block.expression)}</pre>`;
        case "anchor":
            return "";
        case "list":
            return block.items.map(item => {
                const label = item.has_checkbox
                    ? (item.is_checked ? "☑" : "☐")
                    : item.value !== undefined
                        ? `${item.value}.`
                        : item.label || "•";
                return `${label} ${blocksToHtml(item.blocks).replace(/\n\n/g, "\n")}`.trim();
            }).join("\n");
        case "blockquote": {
            const credit = block.credit ? `\n— <i>${richTextToHtml(block.credit)}</i>` : "";
            return `<blockquote>${blocksToHtml(block.blocks).replace(/\n\n/g, "\n")}${credit}</blockquote>`;
        }
        case "collage":
        case "slideshow":
            return [blocksToHtml(block.blocks), captionToHtml(block.caption)].filter(Boolean).join("\n");
        case "table":
            return tableToHtml(block);
        case "details":
            return `<b>🔹 ${richTextToHtml(block.summary)}</b>\n${blocksToHtml(block.blocks)}`;
        case "map":
            return ["📍 Карта", captionToHtml(block.caption)].filter(Boolean).join(" — ");
        case "animation":
            return ["🎞 Анімація", captionToHtml(block.caption)].filter(Boolean).join(" — ");
        case "audio":
            return ["🎵 Аудіо", captionToHtml(block.caption)].filter(Boolean).join(" — ");
        case "photo":
            return ["🖼 Фото", captionToHtml(block.caption)].filter(Boolean).join(" — ");
        case "video":
            return ["🎥 Відео", captionToHtml(block.caption)].filter(Boolean).join(" — ");
        case "voice_note":
            return ["🎤 Голосове повідомлення", captionToHtml(block.caption)].filter(Boolean).join(" — ");
    }
}

/** Converts new Telegram Rich Messages into the stable HTML subset supported by sendMessage. */
export function getRichMessageHtml(richMessage?: RichMessage): string {
    if (!richMessage) return "";
    return blocksToHtml(richMessage.blocks)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
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
