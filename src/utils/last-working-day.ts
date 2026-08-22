/**
 * Останній робочий день людини всередині конкретного місяця календаря.
 *
 * Бекенд віддає `worksUntil` як дату (`YYYY-MM-DD`) або `null`. Клавіатура
 * побажань малюється на весь місяць, тож без цього обмеження людина, яка
 * доопрацьовує до 5-го, бачила б усі 30 днів — включно з тими, коли її вже
 * не буде.
 */
export function lastSelectableDay(
    worksUntil: string | null | undefined,
    year: number,
    monthIndex: number,
    daysInMonth: number,
): number {
    if (!worksUntil) return daysInMonth;

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(worksUntil);
    // Незрозумілий формат — не ріжемо календар: краще зайвий день у
    // клавіатурі, ніж мовчки прихований місяць у того, хто працює далі.
    if (!match) return daysInMonth;

    const untilYear = Number(match[1]);
    const untilMonthIndex = Number(match[2]) - 1;
    const untilDay = Number(match[3]);

    // Місяць цілком після звільнення — жодного дня для позначок.
    if (untilYear < year || (untilYear === year && untilMonthIndex < monthIndex)) return 0;
    // Звільнення пізніше цього місяця — обмеження не діє.
    if (untilYear > year || untilMonthIndex > monthIndex) return daysInMonth;

    // Межа включна: останній робочий день — ще робочий.
    return Math.min(untilDay, daysInMonth);
}

/** Родовий відмінок: «31 серпня», а не «31 серпень». */
const MONTHS_GENITIVE = [
    "січня", "лютого", "березня", "квітня", "травня", "червня",
    "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
] as const;

/**
 * Дата останнього робочого дня у вигляді, придатному для повідомлення.
 * Нерозпізнаний рядок повертається як є: краще технічний вигляд, ніж
 * порожнє місце там, де людина чекає дату.
 */
export function formatWorksUntil(worksUntil: string | null | undefined): string {
    if (!worksUntil) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(worksUntil);
    if (!match) return worksUntil;

    const monthName = MONTHS_GENITIVE[Number(match[2]) - 1];
    if (monthName === undefined) return worksUntil;

    return `${Number(match[3])} ${monthName}`;
}
