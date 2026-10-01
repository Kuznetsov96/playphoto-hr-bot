const KYIV_TIME_ZONE = "Europe/Kyiv";

/**
 * «пт 12.09 · 14:00» — день тижня, дата й час у київській зоні.
 *
 * Один формат на кнопки слотів (handlers/booking.ts) і на строк у
 * нагадуванні про запрошення, де роздільник — кома: «пт 03.10, 14:00».
 * Без timeZone сервер в UTC показав би сусідній день біля опівночі.
 */
export function formatKyivWeekdayDateTime(date: Date, separator: string = " · "): string {
    const weekday = date.toLocaleDateString("uk-UA", { weekday: "short", timeZone: KYIV_TIME_ZONE });
    const dateStr = date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: KYIV_TIME_ZONE });
    const timeStr = date.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: KYIV_TIME_ZONE });
    return `${weekday} ${dateStr}${separator}${timeStr}`;
}
