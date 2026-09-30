import logger from "../core/logger.js";
import { systemStateRepository } from "../repositories/system-state-repository.js";
import { findAvailableInterviewSlots } from "./canonical-interview-slots.js";
import { hrService } from "./hr-service.js";

/**
 * Обіцянка «надішлемо сповіщення, щойно з'являться нові вікна».
 *
 * До 30.09.2026 її не виконував ніхто: `notifyWaitlist` існував, але його не
 * викликали, і кандидатки без слота (49 на той день) чекали повідомлення, яке
 * не приходило. Бот не знає, коли слот створено, — у веб-слота є лише час
 * початку, — тож запам'ятовує, коли вперше побачив кожен вільний слот.
 * Сповіщення отримує та, хто почала чекати раніше за найновіший із них.
 */
const FIRST_SEEN_KEY = "interview-slots-first-seen:v1";

type FirstSeen = Record<string, string>;

/** Час першої появи для кожного вільного зараз слота; зниклі відкидаються. */
export function mergeFirstSeen(previous: FirstSeen, availableIds: readonly string[], now: Date): FirstSeen {
    const merged: FirstSeen = {};
    for (const id of availableIds) merged[id] = previous[id] ?? now.toISOString();
    return merged;
}

/** Найновіша поява серед вільних слотів; null — вільних немає. */
export function newestFirstSeen(firstSeen: FirstSeen): Date | null {
    const times = Object.values(firstSeen).map((value) => new Date(value).getTime());
    return times.length === 0 ? null : new Date(Math.max(...times));
}

export async function notifyWaitlistAboutNewSlots(api: any): Promise<number> {
    const slots = await findAvailableInterviewSlots();
    const previous = (await systemStateRepository.getJson<FirstSeen>(FIRST_SEEN_KEY)) ?? {};
    const firstSeen = mergeFirstSeen(previous, slots.map((slot) => slot.id), new Date());
    await systemStateRepository.setJson(FIRST_SEEN_KEY, firstSeen);

    const newest = newestFirstSeen(firstSeen);
    if (!newest) return 0;

    const notified = await hrService.notifyWaitlist(api, { waitlistedBefore: newest });
    if (notified > 0) logger.info({ notified, newestSlotSeenAt: newest.toISOString() }, "Interview waitlist notified about new slots");
    return notified;
}
