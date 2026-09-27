export const UKRAINIAN_MONTH_INDEX: Record<string, number> = {
    "січень": 0,
    "лютий": 1,
    "березень": 2,
    "квітень": 3,
    "травень": 4,
    "червень": 5,
    "липень": 6,
    "серпень": 7,
    "вересень": 8,
    "жовтень": 9,
    "листопад": 10,
    "грудень": 11
};

/**
 * The preferences session stores a Ukrainian month name plus a numeric year,
 * while the canonical API expects YYYY-MM. Returns null when either part is
 * missing or unrecognised — callers must not fall back to "current month",
 * which would file preferences against the wrong period.
 */
export function toCanonicalMonth(
    monthName: string | undefined,
    year: number | undefined
): string | null {
    if (!monthName || !year) return null;
    const index = UKRAINIAN_MONTH_INDEX[monthName.toLowerCase()];
    if (index === undefined) return null;
    return `${year}-${String(index + 1).padStart(2, "0")}`;
}

const MONTH_NAMES = Object.keys(UKRAINIAN_MONTH_INDEX);

/** `2026-11` → «листопад». null для нечитаемого месяца — угадывать нельзя. */
export function monthNameFromCanonical(month: string | null | undefined): string | null {
    const match = /^(\d{4})-(\d{2})$/u.exec(month ?? "");
    if (!match) return null;
    return MONTH_NAMES[Number(match[2]) - 1] ?? null;
}

/** Месяц, на который собирают пожелания сейчас: следующий по Киеву. `2026-11`. */
export function nextCanonicalMonth(now: Date, timeZone = "Europe/Kyiv"): string {
    const local = new Date(now.toLocaleString("en-US", { timeZone }));
    const next = new Date(local.getFullYear(), local.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Месяц, на который форма собирает пожелания сейчас — то же правило, что в
 * `startPreferencesFlow`: с 23-го следующий, до — текущий. `2026-10`.
 */
export function collectionCanonicalMonth(now: Date, timeZone = "Europe/Kyiv"): string {
    const local = new Date(now.toLocaleString("en-US", { timeZone }));
    const offset = local.getDate() >= 23 ? 1 : 0;
    const target = new Date(local.getFullYear(), local.getMonth() + offset, 1);
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
}

/** Первое число после месяца `YYYY-MM` (полночь UTC): позже сбор на него не нужен. */
export function firstDayAfterMonth(month: string): Date {
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(year, monthNumber, 1));
}

