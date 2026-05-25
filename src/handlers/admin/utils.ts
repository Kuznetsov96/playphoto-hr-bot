import { InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export const CITY_MAP: Record<string, string> = {
    // English targets
    "Lviv": "Lviv",
    "Kyiv": "Kyiv",
    "Kolomyya": "Kolomyya",
    "Kolomyia": "Kolomyya",
    "Khmelnytskyi": "Khmelnytskyi",
    "Zaporizhzhia": "Zaporizhzhia",
    "ZP": "Zaporizhzhia",
    "Cherkasy": "Cherkasy",
    "Rivne": "Rivne",
    "Sambir": "Sambir",
    "Sheptytskyi": "Sheptytskyi",
    "Kharkiv": "Kharkiv",
    "Chortkiv": "Chortkiv",
    "Ternopil": "Ternopil",
    // UA keys -> EN
    "Львів": "Lviv",
    "Київ": "Kyiv",
    "Коломия": "Kolomyya",
    "Коломія": "Kolomyya",
    "Хмельницький": "Khmelnytskyi",
    "Запоріжжя": "Zaporizhzhia",
    "Черкаси": "Cherkasy",
    "Рівне": "Rivne",
    "Рівно": "Rivne",
    "Самбір": "Sambir",
    "Шептицький": "Sheptytskyi",
    "Харків": "Kharkiv",
    "Чортків": "Chortkiv",
    "Тернопіль": "Ternopil",
    // Emoji variants -> EN
    "🦁 Lviv": "Lviv",
    "🏛️ Kyiv": "Kyiv",
    "🌸 Kolomyya": "Kolomyya",
    "🌸 Kolomyia": "Kolomyya",
    "⛰️ Khmelnytskyi": "Khmelnytskyi",
    "⚡ Zaporizhzhia": "Zaporizhzhia",
    "🏰 Cherkasy": "Cherkasy",
    "🌲 Rivne": "Rivne",
    "🔮 Sambir": "Sambir",
    "⛪ Sheptytskyi": "Sheptytskyi",
    "🎓 Kharkiv": "Kharkiv",
    "🦇 Chortkiv": "Chortkiv",
    "🌊 Ternopil": "Ternopil"
};

export const normalizeCity = (city: string) => {
    const trimmed = city.trim();
    if (CITY_MAP[trimmed]) return CITY_MAP[trimmed];
    // Fallback: strip emojis and non-alphanumeric (except space) to try and match
    const clean = trimmed.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    return CITY_MAP[clean] || clean;
};

export const CHAT_ID_TO_NAME: Record<number, string> = {
    [-1002323329492]: "Khmelnytskyi Team",
    [-1002378901316]: "Lviv Fly Kids",
    [-1003068768533]: "Lviv Smile Park",
    [-1001956336405]: "Lviv Leoland",
    [-1001933184668]: "Lviv Drive City",
    [-1002571420646]: "Lviv Dragon Park",
    [-1002429009554]: "Kyiv SP Darynok",
    [-1002373731296]: "Kyiv SP Kyiv",
    [-1002625052844]: "Kyiv FK Kyiv",
    [-1001982334091]: "Kyiv Kidlandia",
    [-1002331115725]: "ZP Volkland 1",
    [-1002695718575]: "ZP Volkland 2",
    [-1003005306666]: "ZP Volkland 3",
    [-1002292905493]: "Cherkasy Team",
    [-1003453458076]: "Rivne Team",
    [-1003043444121]: "Sambir Team",
    [-1002425476970]: "Kolomyya Team",
    [-1002446398843]: "Sheptytskyi Team",
    [-1002649143773]: "Kharkiv Team"
};

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function getAdminOutboundText(message: MyContext["message"] | undefined): string {
    return message?.text || message?.caption || "";
}

export async function sendAdminOutboundMessage(
    ctx: MyContext,
    targetChatId: number,
    options?: {
        messageThreadId?: number;
        replyMarkup?: InstanceType<typeof InlineKeyboard>;
        prefixText?: boolean;
    }
) {
    const message = ctx.message;
    if (!message?.message_id || !ctx.chat?.id) {
        throw new Error("Admin outbound message is missing source chat context");
    }

    const text = getAdminOutboundText(message);
    const formattedHtmlText = msgToHtml(
        text,
        (message.text ? message.entities : message.caption_entities) || []
    );
    const hasMedia = Boolean(
        message.photo || message.video || message.document || message.voice || message.video_note || message.audio || message.animation
    );

    if (hasMedia) {
        const copyOptions: Record<string, unknown> = {};
        if (options?.messageThreadId !== undefined) {
            copyOptions.message_thread_id = options.messageThreadId;
        }
        if (options?.replyMarkup) {
            copyOptions.reply_markup = options.replyMarkup;
        }

        await ctx.api.copyMessage(targetChatId, ctx.chat.id, message.message_id, copyOptions as any);
        return;
    }

    const htmlText = options?.prefixText === false
        ? formattedHtmlText
        : `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${formattedHtmlText}`;

    const sendOptions: Record<string, unknown> = {
        parse_mode: "HTML",
    };
    if (options?.messageThreadId !== undefined) {
        sendOptions.message_thread_id = options.messageThreadId;
    }
    if (options?.replyMarkup) {
        sendOptions.reply_markup = options.replyMarkup;
    }

    await ctx.api.sendMessage(targetChatId, htmlText, sendOptions as any);
}

export function msgToHtml(text: string, entities: any[] = []): string {
    if (!entities || entities.length === 0) return escapeHtml(text);

    // Create a list of all markers (open/close tags)
    interface Marker {
        offset: number;
        type: string;
        isClose: boolean;
        length: number;
        url?: string;
    }

    const markers: Marker[] = [];

    for (const entity of entities) {
        markers.push({ offset: entity.offset, type: entity.type, isClose: false, length: entity.length, url: entity.url });
        markers.push({ offset: entity.offset + entity.length, type: entity.type, isClose: true, length: entity.length });
    }

    // Telegram entities can be nested and may share the same boundary.
    // Outer tags must open first, while inner tags must close first.
    markers.sort((a, b) => {
        if (a.offset !== b.offset) return a.offset - b.offset;
        if (a.isClose !== b.isClose) return a.isClose ? -1 : 1;
        return a.isClose ? a.length - b.length : b.length - a.length;
    });

    let result = "";
    let lastPos = 0;

    for (const marker of markers) {
        // Add text between last marker and current marker
        if (marker.offset > lastPos) {
            result += escapeHtml(text.slice(lastPos, marker.offset));
            lastPos = marker.offset;
        }

        const tagMap: Record<string, string> = {
            bold: "b",
            italic: "i",
            underline: "u",
            strikethrough: "s",
            code: "code",
            pre: "pre",
            blockquote: "blockquote",
            expandable_blockquote: "blockquote",
            spoiler: "tg-spoiler",
        };

        const tag = tagMap[marker.type];
        if (marker.isClose) {
            if (tag) result += `</${tag}>`;
            else if (marker.type === "text_link") result += "</a>";
        } else {
            if (tag) result += `<${tag}>`;
            else if (marker.type === "text_link") {
                const escapedUrl = marker.url?.replace(/"/g, '&quot;') || "";
                result += `<a href="${escapedUrl}">`;
            }
        }
    }

    // Add remaining text
    result += escapeHtml(text.slice(lastPos));
    return result;
}

function splitTelegramHtmlMessage(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
        const hardLimit = maxLength - 40;
        const newlineIndex = remaining.lastIndexOf("\n", hardLimit);
        const spaceIndex = remaining.lastIndexOf(" ", hardLimit);
        const splitAt = newlineIndex > 500 ? newlineIndex : (spaceIndex > 500 ? spaceIndex : hardLimit);

        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

export async function sendLongHtmlMessage(
    ctx: MyContext,
    targetChatId: number,
    htmlText: string,
    options?: {
        replyMarkup?: InstanceType<typeof InlineKeyboard>;
        messageThreadId?: number;
    }
) {
    const chunks = splitTelegramHtmlMessage(htmlText);

    for (let i = 0; i < chunks.length; i++) {
        const sendOptions: Record<string, unknown> = {
            parse_mode: "HTML",
        };
        if (options?.messageThreadId !== undefined) {
            sendOptions.message_thread_id = options.messageThreadId;
        }
        if (options?.replyMarkup && i === chunks.length - 1) {
            sendOptions.reply_markup = options.replyMarkup;
        }

        await ctx.api.sendMessage(targetChatId, chunks[i]!, sendOptions as any);
    }
}

export function getMessageHtml(message: MyContext["message"] | undefined): string {
    if (!message) return "";
    const text = message.text || message.caption || "";
    const entities = message.text ? message.entities : message.caption_entities;
    return msgToHtml(text, entities || []);
}

export async function sendTaskNotification(
    ctx: MyContext,
    targetChatId: number,
    text: string,
    options?: {
        replyMarkup?: InstanceType<typeof InlineKeyboard>;
        sourceChatId?: number;
        sourceMessageId?: number;
        fileId?: string | null;
        mediaType?: "photo" | "video" | "document" | "voice" | "video_note" | "audio" | "animation";
        textIsHtml?: boolean;
    }
) {
    if (options?.sourceChatId && options?.sourceMessageId) {
        await ctx.api.copyMessage(targetChatId, options.sourceChatId, options.sourceMessageId);
    } else if (options?.fileId) {
        if (options.mediaType === "video") await ctx.api.sendVideo(targetChatId, options.fileId);
        else if (options.mediaType === "document") await ctx.api.sendDocument(targetChatId, options.fileId);
        else if (options.mediaType === "voice") await ctx.api.sendVoice(targetChatId, options.fileId);
        else if (options.mediaType === "video_note") await ctx.api.sendVideoNote(targetChatId, options.fileId);
        else if (options.mediaType === "audio") await ctx.api.sendAudio(targetChatId, options.fileId);
        else if (options.mediaType === "animation") await ctx.api.sendAnimation(targetChatId, options.fileId);
        else await ctx.api.sendPhoto(targetChatId, options.fileId);
    }

    const htmlText = options?.textIsHtml ? text : escapeHtml(text);
    const longMessageOptions: { replyMarkup?: InstanceType<typeof InlineKeyboard> } = {};
    if (options?.replyMarkup) longMessageOptions.replyMarkup = options.replyMarkup;
    await sendLongHtmlMessage(ctx, targetChatId, htmlText, longMessageOptions);
}

/**
 * Cleans up raw location names from DDS/Technical prefixes
 * and formats them as "Name (City)"
 * @example "Выручка от продаж Leolend (Lviv)" -> "Leolend (Lviv)"
 */
export function formatLocationName(rawName: string, city: string): string {
    // 1. Remove common technical prefixes (DDS articles)
    // Supports RU/UA variants: "Выручка от продаж", "Виручка від продажу", "Дохід ", etc.
    let clean = rawName
        .replace(/^(Выручка от продаж|Виручка від продажу|Дохід|Стаття)\s+/i, '')
        .trim();

    // 2. Remove all variants of the city name to avoid "Smile Park Kharkiv (Kharkiv)"
    // or "Карамель Шептицький (Sheptytskyi)".
    const normalizedCityName = normalizeCity(city).normalize('NFC');
    const cityNoEmoji = city.replace(/[^\p{L}\p{N}\s]/gu, '').trim().normalize('NFC');

    const cityVariants = new Set<string>();
    Object.entries(CITY_MAP).forEach(([key, value]) => {
        if (value === normalizedCityName) {
            cityVariants.add(key.replace(/[^\p{L}\p{N}\s]/gu, '').trim().normalize('NFC'));
        }
    });
    cityVariants.add(cityNoEmoji);

    const sortedVariants = Array.from(cityVariants)
        .filter(v => v.length > 2)
        .sort((a, b) => b.length - a.length);

    let nfcClean = clean.normalize('NFC');

    for (const variant of sortedVariants) {
        // More aggressive: remove variant even if it's part of a word or has no boundaries
        // This helps with "КаремельКоломия" or similar cases if they exist
        const variantRegex = new RegExp(`${variant}`, 'gi');
        if (variantRegex.test(nfcClean)) {
            nfcClean = nfcClean.replace(variantRegex, ' ').trim();
        }
    }

    // 2.5 Translate brands and common words to English
    const BRAND_MAP: Record<string, string> = {
        "Карамель": "Karamel",
        "Каремель": "Karamel",
        "Смайл Парк": "Smile Park",
        "СмайлПарк": "Smile Park",
        "Флай Кідс": "Fly Kids",
        "ФлайКідс": "Fly Kids",
        "Леоленд": "Leoland",
        "Драйв Сіті": "Drive City",
        "Драгон Парк": "Dragon Park",
        "Дитяче горище": "Children's Attic",
        "Чортків": "Chortkiv",
        "Самбір": "Sambir",
        "Коломия": "Kolomyya",
        "Шептицький": "Sheptytskyi",
        "Харків": "Kharkiv",
        "Львів": "Lviv",
        "Рівне": "Rivne",
        "Черкаси": "Cherkasy",
        "Запоріжжя": "Zaporizhzhia"
    };

    for (const [ua, en] of Object.entries(BRAND_MAP)) {
        const brandRegex = new RegExp(`${ua}`, 'gi');
        nfcClean = nfcClean.replace(brandRegex, en);
    }

    // 2.6 Normalize "Volkland" (without number) to "Volkland 1"
    nfcClean = nfcClean.replace(/\bVolkland\b(?!\s*\d)/gi, 'Volkland 1');

    // Final cleanup of extra spaces or empty parentheses
    const finalClean = nfcClean
        .replace(/\s*\(\s*\)\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 3. Final format: "Location (City)" with English city name
    const englishCity = normalizeCity(cityNoEmoji);
    return `${finalClean} (${englishCity})`;
}
