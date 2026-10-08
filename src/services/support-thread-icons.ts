import type { Api } from "grammy";
import logger from "../core/logger.js";
import type { ThreadStatus } from "../utils/support-thread-format.js";

/**
 * Іконка теми — це статус (spec 2026-10-08). Боту дозволено лише набір
 * `getForumTopicIconStickers`; на проді 08.10.2026 у ньому були всі чотири
 * перші варіанти (💬 ✅ 👀 📁). Решта — запас на випадок, якщо Telegram змінить набір.
 */
const PREFERRED: Record<ThreadStatus, string[]> = {
    // 💬 — рішення власника 08.10: ❗️ кричить, коли таких тем у списку з десяток.
    WAITING: ["💬", "❗", "🔥"],
    ANSWERED: ["✅"],
    ESCALATED: ["👀", "⚡"],
    ARCHIVED: ["📁", "🗂"],
};

export type ThreadIcons = Record<ThreadStatus, string | null>;

const strip = (emoji: string) => emoji.replace(/\uFE0F/g, "");

let cached: Promise<ThreadIcons> | null = null;

export function pickThreadIcons(stickers: { emoji?: string; custom_emoji_id?: string }[]): ThreadIcons {
    const byEmoji = new Map<string, string>();
    for (const sticker of stickers) {
        if (sticker.emoji && sticker.custom_emoji_id) byEmoji.set(strip(sticker.emoji), sticker.custom_emoji_id);
    }
    const result = {} as ThreadIcons;
    for (const status of Object.keys(PREFERRED) as ThreadStatus[]) {
        const found = PREFERRED[status].map(emoji => byEmoji.get(strip(emoji))).find(Boolean) ?? null;
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
                return { WAITING: null, ANSWERED: null, ESCALATED: null, ARCHIVED: null };
            });
    }
    return cached;
}
