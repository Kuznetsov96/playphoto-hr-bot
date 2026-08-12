import { InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getRichMessageHtml, getRichMessageMedia } from "../../utils/rich-message.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

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

export function htmlToPlainText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(blockquote|div|p|pre)>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function escapeHtmlAttribute(text: string): string {
    return escapeHtml(text).replace(/"/g, "&quot;");
}

export function getAdminOutboundText(message: MyContext["message"] | undefined): string {
    return message?.text || message?.caption || message?.checklist?.title || "";
}

export function buildAdminOutboundReplyKeyboard(options: {
    hasStaffProfile: boolean;
    candidateGender?: string | null;
}) {
    if (options.hasStaffProfile) {
        return new InlineKeyboard().text("💬 Відповісти", "staff_support_reply");
    }

    if (options.candidateGender && options.candidateGender !== "male") {
        return new InlineKeyboard().text("💬 Відповісти", "contact_hr");
    }

    return undefined;
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

    const formattedHtmlText = getMessageHtml(message);
    if (message.rich_message) {
        const mediaOptions = options?.messageThreadId !== undefined
            ? { message_thread_id: options.messageThreadId }
            : {};
        for (const media of getRichMessageMedia(message.rich_message)) {
            if (media.type === "photo") await ctx.api.sendPhoto(targetChatId, media.fileId, mediaOptions);
            else if (media.type === "video") await ctx.api.sendVideo(targetChatId, media.fileId, mediaOptions);
            else if (media.type === "voice") await ctx.api.sendVoice(targetChatId, media.fileId, mediaOptions);
            else if (media.type === "audio") await ctx.api.sendAudio(targetChatId, media.fileId, mediaOptions);
            else await ctx.api.sendAnimation(targetChatId, media.fileId, mediaOptions);
        }
    }
    // Telegram keeps adding copyable non-text message types. Treat only actual
    // text messages as text so stickers and other payloads are not sent as an
    // empty sendMessage call.
    const shouldCopyMessage = !message.text && !message.rich_message && !message.checklist;

    if (shouldCopyMessage) {
        const copyOptions: Record<string, unknown> = {};
        if (options?.messageThreadId !== undefined) {
            copyOptions.message_thread_id = options.messageThreadId;
        }
        if (text.length > TELEGRAM_CAPTION_LIMIT) {
            copyOptions.caption = "";
        } else if (options?.replyMarkup) {
            copyOptions.reply_markup = options.replyMarkup;
        }

        await ctx.api.copyMessage(targetChatId, ctx.chat.id, message.message_id, copyOptions as any);

        if (text.length > TELEGRAM_CAPTION_LIMIT) {
            const longCaptionOptions: {
                replyMarkup?: InstanceType<typeof InlineKeyboard>;
                messageThreadId?: number;
            } = {};
            if (options?.messageThreadId !== undefined) {
                longCaptionOptions.messageThreadId = options.messageThreadId;
            }
            if (options?.replyMarkup) {
                longCaptionOptions.replyMarkup = options.replyMarkup;
            }

            await sendLongHtmlMessage(ctx, targetChatId, formattedHtmlText, longCaptionOptions);
        }
        return;
    }

    const htmlText = options?.prefixText === false
        ? formattedHtmlText
        : `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${formattedHtmlText}`;

    const longMessageOptions: {
        replyMarkup?: InstanceType<typeof InlineKeyboard>;
        messageThreadId?: number;
    } = {};
    if (options?.messageThreadId !== undefined) {
        longMessageOptions.messageThreadId = options.messageThreadId;
    }
    if (options?.replyMarkup) {
        longMessageOptions.replyMarkup = options.replyMarkup;
    }

    await sendLongHtmlMessage(ctx, targetChatId, htmlText, longMessageOptions);
}

export function msgToHtml(text: string, entities: any[] = []): string {
    if (!entities || entities.length === 0) return escapeHtml(text);

    interface HtmlEntity {
        index: number;
        end: number;
        start: number;
        type: string;
        length: number;
        url?: string;
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

    const supportedEntities: HtmlEntity[] = entities
        .map((entity, index) => ({
            index,
            start: Number(entity.offset),
            end: Number(entity.offset) + Number(entity.length),
            type: entity.type,
            length: Number(entity.length),
            url: entity.url,
        }))
        .filter((entity) => {
            if (!Number.isFinite(entity.start) || !Number.isFinite(entity.end)) return false;
            if (entity.length <= 0 || entity.start < 0 || entity.end > text.length) return false;
            return Boolean(tagMap[entity.type] || entity.type === "text_link");
        });

    if (supportedEntities.length === 0) return escapeHtml(text);

    const boundaries = Array.from(new Set([
        0,
        text.length,
        ...supportedEntities.flatMap((entity) => [entity.start, entity.end]),
    ])).sort((a, b) => a - b);

    const entityKey = (entity: HtmlEntity) => `${entity.index}:${entity.type}:${entity.start}:${entity.end}:${entity.url || ""}`;
    const entityTag = (entity: HtmlEntity) => tagMap[entity.type] || "a";
    const openTag = (entity: HtmlEntity) => {
        if (entity.type === "text_link") return `<a href="${escapeHtmlAttribute(entity.url || "")}">`;
        return `<${entityTag(entity)}>`;
    };
    const closeTag = (entity: HtmlEntity) => `</${entityTag(entity)}>`;
    const sortActiveEntities = (active: HtmlEntity[]) => active.sort((a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        a.index - b.index
    );

    let result = "";
    let activeEntities: HtmlEntity[] = [];

    for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i]!;
        const end = boundaries[i + 1]!;
        if (start === end) continue;

        const nextActiveEntities = sortActiveEntities(
            supportedEntities.filter((entity) => entity.start <= start && entity.end >= end)
        );

        let commonPrefixLength = 0;
        while (
            commonPrefixLength < activeEntities.length &&
            commonPrefixLength < nextActiveEntities.length &&
            entityKey(activeEntities[commonPrefixLength]!) === entityKey(nextActiveEntities[commonPrefixLength]!)
        ) {
            commonPrefixLength++;
        }

        for (let j = activeEntities.length - 1; j >= commonPrefixLength; j--) {
            result += closeTag(activeEntities[j]!);
        }
        for (let j = commonPrefixLength; j < nextActiveEntities.length; j++) {
            result += openTag(nextActiveEntities[j]!);
        }

        result += escapeHtml(text.slice(start, end));
        activeEntities = nextActiveEntities;
    }

    for (let j = activeEntities.length - 1; j >= 0; j--) {
        result += closeTag(activeEntities[j]!);
    }

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
    if (message.rich_message) return getRichMessageHtml(message.rich_message);
    if (message.checklist) {
        const title = msgToHtml(message.checklist.title, message.checklist.title_entities || []);
        const tasks = message.checklist.tasks.map(task => {
            const marker = task.completion_date ? "☑" : "☐";
            return `${marker} ${msgToHtml(task.text, task.text_entities || [])}`;
        });
        return [`<b>${title}</b>`, ...tasks].join("\n");
    }
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
 * and formats them as "Name (Branch) (City)"
 *
 * `branch` is the canonical discriminator for venues sharing a name — the three Zaporizhzhia
 * Volklands are all named "Volkland" and differ only by branch. Pass it whenever it is
 * known, or same-named locations collapse into one indistinguishable label.
 *
 * @example "Выручка от продаж Leolend" -> "Leolend (Lviv)"
 * @example ("Volkland", "Запоріжжя", "Шевчик") -> "Volkland (Шевчик) (Zaporizhzhia)"
 */
export function formatLocationName(rawName: string, city: string, branch?: string | null): string {
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

    // 2.6 The canonical `branch` now distinguishes same-named venues. The old rule here
    // rewrote a bare "Volkland" to "Volkland 1", which invented a fact: it turned an unknown
    // branch into a confident and often wrong "1". An unbranded name stays as it is.

    // Final cleanup of extra spaces or empty parentheses
    const finalClean = nfcClean
        .replace(/\s*\(\s*\)\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 3. Final format: "Location (Branch) (City)" with English city name
    const englishCity = normalizeCity(cityNoEmoji);
    const trimmedBranch = branch?.trim();
    const withBranch = trimmedBranch ? `${finalClean} (${trimmedBranch})` : finalClean;
    return `${withBranch} (${englishCity})`;
}
