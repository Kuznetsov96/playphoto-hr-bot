/** Индексируется значением `Date.getUTCDay()`: 0 — воскресенье. */
const WEEKDAY_SHORT_UK = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

/** До скольких смен показывается полный список. */
const FULL_LIST_LIMIT = 15;

/** Сколько строк остаётся, когда список не помещается целиком. */
const LIST_HEAD = 10;

export type ScheduleMessageShift = {
    localDate: string;
    locationLabel: string;
    startsAtLocal: string;
    endsAtLocal: string;
};

/**
 * Склонение «зміна» по украинским правилам: 1 зміна, 2–4 зміни, 5+ змін.
 * Числа 11–14 — исключение, они идут по форме множественного числа.
 */
function shiftWord(count: number): string {
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return "змін";
    if (last === 1) return "зміна";
    if (last >= 2 && last <= 4) return "зміни";
    return "змін";
}

/**
 * Сообщение фотографу о том, что график месяца опубликован.
 *
 * Список обрезается по числу СТРОК, а не по символам. Лимит Telegram — 4096
 * знаков, и сообщение сверх него не отправляется вовсе: человек просто не
 * узнает свой график в день публикации. Резать по символам нельзя — обрубок
 * даты хуже, чем честное «та ще N».
 */
export function formatScheduleMessage(input: {
    monthName: string;
    shifts: ScheduleMessageShift[];
}): string {
    const total = input.shifts.length;
    const shown = total <= FULL_LIST_LIMIT ? input.shifts : input.shifts.slice(0, LIST_HEAD);
    const rows = shown
        .map((shift) => {
            const weekday = WEEKDAY_SHORT_UK[new Date(`${shift.localDate}T12:00:00.000Z`).getUTCDay()];
            const dayMonth = `${shift.localDate.slice(8)}.${shift.localDate.slice(5, 7)}`;
            return `  ${weekday} ${dayMonth}   ${shift.locationLabel}    ${shift.startsAtLocal}–${shift.endsAtLocal}`;
        })
        .join("\n");

    const tail =
        total > FULL_LIST_LIMIT
            ? `\n\n  та ще ${total - LIST_HEAD} — дивись у розділі «Мій графік»`
            : "";

    return `✅ <b>Графік на ${input.monthName} готовий</b>

У тебе ${total} ${shiftWord(total)}:

${rows}${tail}

Якщо якийсь день не підійде — відкрий «Мій графік» і попроси підміну.`;
}
