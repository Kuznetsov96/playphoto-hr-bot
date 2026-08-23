import { PING_CONFIG } from "../config.js";

/**
 * Час по Киеву для произвольного момента.
 *
 * Через `Intl`, а не через смещение в миллисекундах: Украина переходит на
 * летнее время, и захардкоженный +2/+3 давал бы промах на час дважды в год —
 * ровно в те дни, когда идёт сбор пожеланий на ноябрь и на апрель.
 */
export function kyivHour(at: Date): number {
    const formatted = at.toLocaleString("en-US", {
        timeZone: PING_CONFIG.TIME_ZONE,
        hour: "2-digit",
        hour12: false,
    });
    return Number(formatted);
}

/**
 * Попадает ли момент в тихие часы (22:00–10:00 по Киеву).
 *
 * Окно пересекает полночь, поэтому проверка через OR, а не через диапазон:
 * 23:00 больше 22, а 02:00 меньше 10, и оба — ночь.
 */
export function isQuietHour(at: Date): boolean {
    const hour = kyivHour(at);
    return hour >= PING_CONFIG.QUIET_FROM_HOUR || hour < PING_CONFIG.QUIET_UNTIL_HOUR;
}

/**
 * Ближайший момент, когда напоминание уместно.
 *
 * Днём возвращает то же время — напоминание уходит сразу. Ночью переносит на
 * ближайшие 10:00 по Киеву, а не просто добавляет интервал: сложение часов
 * могло бы снова попасть в ночь, и человек получил бы пинг в 04:00 вместо
 * 02:00. Смысл окна в том, что ночью бот молчит, а не напоминает реже.
 *
 * Шаг в один час, а не арифметика с датой: перевод часов делает «завтра в
 * 10:00» неоднозначным, а поиск первого нетихого часа корректен в обе стороны
 * перевода и не зависит от того, была ли ночь длиннее или короче обычной.
 */
export function nextAllowedPingTime(at: Date): Date {
    if (!isQuietHour(at)) return at;

    const candidate = new Date(at.getTime());
    // Ночное окно длится максимум 12 часов; лимит в 24 шага — предохранитель от
    // бесконечного цикла, если конфигурацию однажды зададут так, что тихо всегда.
    for (let step = 0; step < 24; step++) {
        candidate.setUTCMinutes(0, 0, 0);
        candidate.setUTCHours(candidate.getUTCHours() + 1);
        if (!isQuietHour(candidate)) return candidate;
    }
    return at;
}
