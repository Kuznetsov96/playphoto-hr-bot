import { escapeHtml } from "../handlers/admin/utils.js";

/** Індексується значенням `Date.getUTCDay()`: 0 — неділя. */
const WEEKDAY_SHORT_UK = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

/** «Графік на вересень» — знахідний відмінок збігається з називним. */
const MONTHS_UK_NOMINATIVE = [
    "січень",
    "лютий",
    "березень",
    "квітень",
    "травень",
    "червень",
    "липень",
    "серпень",
    "вересень",
    "жовтень",
    "листопад",
    "грудень",
] as const;

/** До скількох змін показується повний список. */
const FULL_LIST_LIMIT = 15;

/** Скільки рядків лишається, коли список не вміщується цілком. */
const LIST_HEAD = 10;

export type ScheduleMessageShift = {
    /** `YYYY-MM-DD` — локальна дата зміни. */
    localDate: string;
    locationLabel: string;
    startsAtLocal: string;
    endsAtLocal: string;
};

/** `2026-09-05` -> 6 (субота). Дата читається як текст, без таймзони. */
function weekdayOf(localDate: string): number {
    return new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
}

function isWeekend(localDate: string): boolean {
    const day = weekdayOf(localDate);
    return day === 0 || day === 6;
}

/** `2026-09-05` -> «вересень». Порожньо, якщо дата не читається. */
export function monthNameOf(localDate: string): string {
    const month = Number(localDate.slice(5, 7));
    return MONTHS_UK_NOMINATIVE[month - 1] ?? "";
}

/**
 * Повідомлення фотографу про те, що графік місяця опубліковано.
 *
 * Будова — за ієрархією читання: що сталося → скільки і скільки з них у
 * вихідні (саме це люди порівнюють між собою, бо вихідні найкасовіші) →
 * календар → що робити далі. Підсумок рахується по ВСІХ локаціях людини
 * разом: на дошці однієї локації її частка виглядає меншою, ніж є.
 *
 * Вихідні в списку виділені, щоб їх було видно з одного погляду, а не
 * рахувати по датах. Список іде за датою незалежно від порядку входу.
 *
 * Список обрізається за числом РЯДКІВ, а не за символами. Ліміт Telegram —
 * 4096 знаків, і повідомлення понад нього не відправляється взагалі: людина
 * просто не дізнається свій графік у день публікації. Різати за символами
 * не можна — обрубок дати гірший за чесне «та ще N».
 *
 * Підписи локацій приходять із каталогу і екрануються тут, бо результат іде
 * в Telegram як HTML.
 */
export function formatScheduleMessage(input: { monthName: string; shifts: ScheduleMessageShift[] }): string {
    const ordered = [...input.shifts].sort((left, right) => left.localDate.localeCompare(right.localDate));
    const total = ordered.length;
    const weekends = ordered.filter((shift) => isWeekend(shift.localDate)).length;
    const shown = total <= FULL_LIST_LIMIT ? ordered : ordered.slice(0, LIST_HEAD);

    const rows = shown
        .map((shift) => {
            const weekday = WEEKDAY_SHORT_UK[weekdayOf(shift.localDate)];
            const dayMonth = `${shift.localDate.slice(8)}.${shift.localDate.slice(5, 7)}`;
            const day = isWeekend(shift.localDate) ? `<b>${weekday} ${dayMonth}</b>` : `${weekday} ${dayMonth}`;
            // Роздільник, а не колонки з пробілів: у Telegram шрифт пропорційний,
            // і «вирівняні» пробілами стовпці розповзаються на кожному рядку.
            return `${day} · ${escapeHtml(shift.locationLabel)} · ${shift.startsAtLocal}–${shift.endsAtLocal}`;
        })
        .join("\n");

    const tail = total > FULL_LIST_LIMIT ? `\n\nта ще ${total - LIST_HEAD} — дивись у розділі «Мій графік»` : "";
    const title = input.monthName ? `Графік на ${input.monthName} готовий` : "Графік готовий";
    const summary =
        weekends > 0
            ? `Змін: <b>${total}</b> · у вихідні: <b>${weekends}</b>`
            : `Змін: <b>${total}</b>`;

    return `✅ <b>${title}</b>

${summary}

${rows}${tail}

Якщо якийсь день не підійде — відкрий «Мій графік» і попроси підміну.`;
}
