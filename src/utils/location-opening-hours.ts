/**
 * Reads shift times from the canonical `LocationOpeningHours` rows synced from the webapp.
 *
 * Replaces `getShiftTimeFromLocationSchedule`, which parsed a hand-seeded free-text string
 * that nothing kept in sync with the real hours. Two things that format could not express:
 * per-day hours (it only knew "Пн-Пт" and "Сб-Нд") and shifts running past midnight.
 */

export type OpeningHoursDay = {
    dayOfWeek: number;
    opens: string;
    closes: string;
};

/**
 * ISO-8601 weekday (1 = Monday … 7 = Sunday) for the date as it falls in Kyiv.
 *
 * The weekday must be read in the location's timezone: a shift stored at 22:30 UTC on a
 * Saturday is already Sunday in Kyiv, and reading it as Saturday picks the wrong day's hours.
 */
export function isoDayOfWeekInKyiv(date: Date): number {
    const kyivWeekday = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Kyiv",
        weekday: "short",
    }).format(date);

    const isoByWeekday: Record<string, number> = {
        Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
    };
    return isoByWeekday[kyivWeekday] ?? 1;
}

/**
 * `HH:MM-HH:MM` for that date's weekday, or `undefined` when the owner recorded no hours
 * for it. Undefined must surface as "not set" — never as an invented default, which is the
 * bug that made every shift read 10:00-18:00.
 */
export function getShiftTimeFromOpeningHours(
    openingHours: OpeningHoursDay[] | null | undefined,
    date: Date,
): string | undefined {
    if (!openingHours?.length) return undefined;

    const isoDay = isoDayOfWeekInKyiv(date);
    const hours = openingHours.find((day) => day.dayOfWeek === isoDay);
    if (!hours) return undefined;

    // Rendered in stored order: `closes` < `opens` legitimately means past midnight.
    return `${hours.opens}-${hours.closes}`;
}
