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
 * «2026-09-18» — календарна дата в Києві, а не в UTC.
 *
 * Будь-яке місце, що показує людині «сьогодні» чи «завтра» і водночас
 * зберігає дату як `YYYY-MM-DD`, має брати обидва значення з ОДНІЄЇ й тієї ж
 * київської репрезентації моменту: розбіжність між тим, що бачить людина, і
 * тим, що піде в базу, з'являється, коли ярлик береться в одній таймзоні
 * (локальний час сервера, тобто UTC), а рядок дати — в іншій.
 */
export function kyivDateStr(instant: Date, timeZone = "Europe/Kyiv"): string {
    const local = new Date(instant.toLocaleString("en-US", { timeZone }));
    const year = local.getFullYear();
    const month = (local.getMonth() + 1).toString().padStart(2, "0");
    const day = local.getDate().toString().padStart(2, "0");
    return `${year}-${month}-${day}`;
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

/**
 * Момент дедлайна завдання (workDate + deadlineTime "HH:MM") як конкретна
 * мить у Києві — тим самим прийомом, що й kyivDeadline: беремо календарну
 * дату в Києві, будуємо wall-clock у UTC-мілісекундах, тоді віднімаємо
 * київський офсет у САМ шуканий момент (дві ітерації — досить, бо перехід
 * на літній/зимовий час зсуває час максимум на годину).
 */
function taskDeadlineInstant(workDate: Date, deadlineTime: string, timeZone = "Europe/Kyiv"): Date | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(deadlineTime);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;

    const local = new Date(workDate.toLocaleString("en-US", { timeZone }));
    const wallClockMs = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), hours, minutes);

    let utcMs = wallClockMs;
    for (let pass = 0; pass < 2; pass += 1) {
        utcMs = wallClockMs - offsetAt(new Date(utcMs), timeZone);
    }
    return new Date(utcMs);
}

/**
 * Порог, после которого дедлайн считается «скоро» — вперёд по часам от
 * текущего момента. Значение выбрано для рабочего дня: 3 часа — это «уже
 * пора начинать шевелиться», а не «когда-нибудь сегодня». Просроченные
 * задачи считаются срочными всегда, независимо от порога (см. isTaskUrgent).
 */
export const URGENT_DEADLINE_WINDOW_HOURS = 3;

/**
 * 🚨 URGENT должен означать «скоро» или «уже поздно», а не «есть хоть
 * какой-то дедлайн когда-нибудь». Раньше блок заполняли задачи вида
 * «до конца дня через две недели», что приучало админа его игнорировать.
 *
 * Срочно, если задача не выполнена и либо:
 *  — workDate уже в прошлом (по календарной дате в Києві) — просрочено
 *    независимо от времени дедлайна или его отсутствия;
 *  — workDate сегодня и дедлайн уже прошёл (или наступает в пределах
 *    URGENT_DEADLINE_WINDOW_HOURS часов).
 *
 * Задача без deadlineTime на сегодня не срочна, пока день не закончился —
 * "нет времени" не эквивалентно "горит".
 */
export function isTaskUrgent(
    task: { isCompleted: boolean; workDate: Date | null; deadlineTime: string | null },
    now: Date = new Date(),
    timeZone = "Europe/Kyiv",
): boolean {
    if (task.isCompleted || !task.workDate) return false;

    const todayStr = kyivDateStr(now, timeZone);
    const taskDateStr = kyivDateStr(task.workDate, timeZone);

    if (taskDateStr < todayStr) return true; // просрочено — день задачи уже прошёл
    if (taskDateStr > todayStr) return false; // задача на будущее — рано считать срочной

    if (!task.deadlineTime) return false; // сьогодні, але без часу — нема чого відраховувати

    const deadline = taskDeadlineInstant(task.workDate, task.deadlineTime, timeZone);
    if (!deadline) return false;

    const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursUntilDeadline <= URGENT_DEADLINE_WINDOW_HOURS;
}
