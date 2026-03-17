import { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { candidateRepository } from "../repositories/candidate-repository.js";

/**
 * Deletes the last system message sent to a candidate to keep the chat clean.
 */
export async function cleanupSystemMessage(telegramId: number, bot: Bot<MyContext>) {
    try {
        const candidate = await candidateRepository.findByTelegramId(telegramId);

        if (candidate?.lastSystemMessageId) {
            try {
                await bot.api.deleteMessage(telegramId, candidate.lastSystemMessageId);
            } catch (e) {
                // Ignore delete errors (message might be too old or already deleted)
            }
            await candidateRepository.update(candidate.id, { lastSystemMessageId: null });
        }
        return candidate;
    } catch (e) {
        console.error("Помилка очищення системного повідомлення:", e);
        return null;
    }
}

/**
 * Creates a Date object interpreted as Kyiv time, regardless of server timezone.
 */
export function createKyivDate(year: number, month: number, day: number, hour: number, minute: number = 0): Date {
    // 1. Create a UTC date with the given components
    const date = new Date(Date.UTC(year, month, day, hour, minute));
    
    // 2. Use Intl to find what time it would be in Kyiv for this UTC moment
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Kyiv',
        hour: 'numeric',
        hour12: false
    });
    
    const kyivHour = parseInt(formatter.format(date));
    
    // 3. The difference is the offset
    // Example: If we want 14:00 Kyiv and UTC 14:00 results in 16:00 Kyiv, 
    // offset is 16 - 14 = 2. We need to subtract 2 from UTC.
    let offset = kyivHour - hour;
    
    // Handle wrap-around (e.g. 1:00 vs 23:00)
    if (offset > 12) offset -= 24;
    if (offset < -12) offset += 24;
    
    date.setUTCHours(date.getUTCHours() - offset);
    return date;
}
