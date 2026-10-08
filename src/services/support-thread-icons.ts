import type { Api } from "grammy";
import logger from "../core/logger.js";
import type { ThreadStatus } from "../utils/support-thread-format.js";

/**
 * Іконка теми — лише рідкісні стани (рішення власника 08.10): кожна зміна іконки
 * пише в тему службовий рядок «changed the topic icon». «Чекає» і «відповіли» видно
 * з прев'ю останнього повідомлення, тож для них іконки немає (порожній рядок знімає
 * її). Боту дозволено лише набір `getForumTopicIconStickers`; на проді 08.10.2026
 * у ньому були 👀 і 📁, решта — запас на випадок, якщо Telegram змінить набір.
 */
const PREFERRED: Partial<Record<ThreadStatus, string[]>> = {
    ESCALATED: ["👀", "⚡"],
    ARCHIVED: ["📁", "🗂"],
};

/** Порожній рядок — без іконки; null — потрібної іконки в наборі немає. */
export type ThreadIcons = Record<ThreadStatus, string | null>;

const strip = (emoji: string) => emoji.replace(/\uFE0F/g, "");

let cached: Promise<ThreadIcons> | null = null;

export function pickThreadIcons(stickers: { emoji?: string; custom_emoji_id?: string }[]): ThreadIcons {
    const byEmoji = new Map<string, string>();
    for (const sticker of stickers) {
        if (sticker.emoji && sticker.custom_emoji_id) byEmoji.set(strip(sticker.emoji), sticker.custom_emoji_id);
    }
    const result: ThreadIcons = { WAITING: "", ANSWERED: "", ESCALATED: null, ARCHIVED: null };
    for (const status of Object.keys(PREFERRED) as ThreadStatus[]) {
        const found = (PREFERRED[status] ?? []).map(emoji => byEmoji.get(strip(emoji))).find(Boolean) ?? null;
        if (!found) logger.warn({ status }, "Support thread icon is missing from the Telegram topic icon set");
        result[status] = found;
    }
    return result;
}

export function resolveThreadIcons(api: Api): Promise<ThreadIcons> {
    if (!cached) {
        cached = api.getForumTopicIconStickers()
            .then(stickers => pickThreadIcons(stickers))
            .catch(error => {
                cached = null; // наступна спроба запитає знову
                logger.warn({ err: error }, "Support thread icons could not be loaded");
                return { WAITING: "", ANSWERED: "", ESCALATED: null, ARCHIVED: null };
            });
    }
    return cached;
}
