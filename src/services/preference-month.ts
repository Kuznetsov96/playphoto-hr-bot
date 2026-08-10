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
