/**
 * Раскладка рассылки: один файл и короткий текст — одно сообщение с подписью.
 * Правило то же, что у `announcementLayout` вебаппа (общие примеры лежат в
 * `__fixtures__/announcement-layout-cases.json` обоих репозиториев).
 */
export type AnnouncementReplyMode = "CONFIRM" | "NONE";

export type LayoutPart = "photo_or_video" | "album" | "document" | "document_album" | "text" | "follow_up";

export interface LayoutInput {
    media: number;
    documents: number;
    /** Видимая длина текста в единицах UTF-16. */
    visibleLength: number;
    replyMode: AnnouncementReplyMode;
}

export interface Layout {
    textAsCaption: boolean;
    parts: LayoutPart[];
}

/** Предел подписи в Telegram. */
export const CAPTION_LIMIT = 1024;

export function announcementLayout(input: LayoutInput): Layout {
    const { media, documents, visibleLength, replyMode } = input;
    const total = media + documents;
    if (total === 0) return { textAsCaption: false, parts: ["text"] };
    if (total === 1 && visibleLength <= CAPTION_LIMIT) {
        return { textAsCaption: true, parts: [media === 1 ? "photo_or_video" : "document"] };
    }
    const parts: LayoutPart[] = [];
    if (media === 1) parts.push("photo_or_video");
    else if (media > 1) parts.push("album");
    if (documents === 1) parts.push("document");
    else if (documents > 1) parts.push("document_album");
    if (visibleLength > 0) parts.push("text");
    else if (replyMode === "CONFIRM") parts.push("follow_up");
    return { textAsCaption: false, parts };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decodeEntities = (text: string): string =>
    text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
        if (body.startsWith("#")) {
            const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED[body.toLowerCase()] ?? whole;
    });

/**
 * Видимая длина Telegram-HTML в единицах UTF-16 (как считает Telegram для подписи):
 * теги не считаются, сущности раскрываются, ведущие и хвостовые переводы строки
 * отбрасываются, `<br>` — один символ.
 */
export function visibleLength(html: string): number {
    const text = decodeEntities(html.replace(/\r\n?/gu, "\n").replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]*>/gu, ""));
    return text.replace(/^\n+/u, "").replace(/\n+$/u, "").length;
}
