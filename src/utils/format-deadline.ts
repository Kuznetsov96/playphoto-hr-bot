/** Индексируется значением `Date.getDay()`: 0 — воскресенье. */
const WEEKDAYS_UK = [
    "неділя",
    "понеділок",
    "вівторок",
    "середа",
    "четвер",
    "пʼятниця",
    "субота",
] as const;

const MONTHS_UK_GENITIVE = [
    "січня",
    "лютого",
    "березня",
    "квітня",
    "травня",
    "червня",
    "липня",
    "серпня",
    "вересня",
    "жовтня",
    "листопада",
    "грудня",
] as const;

/**
 * «26 серпня, середа».
 *
 * День недели выводится из самой даты, а не пишется в шаблоне: захардкоженный
 * день расходится с датой при первом же переносе дедлайна, и человек получает
 * сообщение, которое само себе противоречит.
 *
 * Дата берётся в киевской зоне, а не в UTC: дедлайн стоит на 23:59 местного
 * времени, и в UTC это уже следующие сутки — сообщение назвало бы соседний
 * день.
 */
export function formatDeadline(deadline: Date, timeZone = "Europe/Kyiv"): string {
    const local = new Date(deadline.toLocaleString("en-US", { timeZone }));
    return `${local.getDate()} ${MONTHS_UK_GENITIVE[local.getMonth()]}, ${WEEKDAYS_UK[local.getDay()]}`;
}

/**
 * Момент, когда закрывается сбор: заданное число месяца, 23:59 по Киеву.
 *
 * Собирать через `new Date(y, m, d, 23, 59)` нельзя: этот конструктор читает
 * компоненты в таймзоне СЕРВЕРА, а в контейнере `TZ` не задан, то есть UTC.
 * Получалось 23:59 UTC — уже 27-е число в Киеве, и сообщение называло бы
 * «27 серпня, четвер» вместо «26 серпня, середа», противореча само себе.
 *
 * Считается от полуночи UTC того же дня: смещение зоны берётся на месте, так
 * что летнее и зимнее время различаются сами собой.
 */
export function kyivDeadline(now: Date, dayOfMonth: number, timeZone = "Europe/Kyiv"): Date {
    const local = new Date(now.toLocaleString("en-US", { timeZone }));
    const midnightUtc = Date.UTC(local.getFullYear(), local.getMonth(), dayOfMonth);
    // Насколько зона опережает UTC в этот день: разница между тем, как один и
    // тот же момент читается в зоне и в UTC.
    const probe = new Date(midnightUtc);
    const offsetMs =
        new Date(probe.toLocaleString("en-US", { timeZone })).getTime() -
        new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    return new Date(midnightUtc + 23 * 60 * 60 * 1000 + 59 * 60 * 1000 - offsetMs);
}
