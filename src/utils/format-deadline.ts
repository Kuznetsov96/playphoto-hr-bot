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
    const wallClockMs = Date.UTC(local.getFullYear(), local.getMonth(), dayOfMonth, 23, 59);

    // Смещение измеряется в САМ искомый час, а не в полночь: в день перевода
    // часов они разные, и замер в полночь сдвигал бы результат на час. Для
    // 29 марта 2026 это давало «30 березня» — та же ошибка «сообщение
    // противоречит себе», ради которой функция и написана.
    //
    // Две итерации: первая берёт смещение по догадке, вторая — уже по
    // найденному моменту. Этого достаточно, потому что перевод часов сдвигает
    // время на час, а не на сутки.
    let utcMs = wallClockMs;
    for (let pass = 0; pass < 2; pass += 1) {
        utcMs = wallClockMs - offsetAt(new Date(utcMs), timeZone);
    }
    return new Date(utcMs);
}

/** Насколько зона опережает UTC в этот момент. */
function offsetAt(instant: Date, timeZone: string): number {
    return (
        new Date(instant.toLocaleString("en-US", { timeZone })).getTime() -
        new Date(instant.toLocaleString("en-US", { timeZone: "UTC" })).getTime()
    );
}
