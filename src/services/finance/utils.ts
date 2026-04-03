
/**
 * Unified normalization for Finance Module.
 * Ensures consistent string matching across DDS, Monobank and TechCash.
 */
export const KYIV_TIME_ZONE = "Europe/Kyiv";

export function normalizeFinanceString(s: string | null | undefined): string {
    if (!s) return "";
    return s.toLowerCase()
        .replace(/[\s\(\)\-\.\'ʼ’`´ʻ‘"«»ьъ]/g, '') // Remove spaces, brackets, dashes, dots, apostrophes, quotes, and soft/hard signs
        .replace(/[іiїи]/g, 'i')       // Handle Latin/Ukrainian/Russian i-sounds
        .replace(/[еє]/g, 'e')        // Handle e/є
        .trim();
}

/**
 * Robust date normalization (DDMMYYYY)
 * Always returns 8 digits (e.g., 16032026)
 */
export function normalizeFinanceDate(d: string | null | undefined): string {
    if (!d) return "";
    const clean = d.trim().replace(/[\s\.\/\-]/g, '');

    // If we have 6 digits (DDMMYY), convert to 8 digits (DDMM20YY)
    if (clean.length === 6) {
        const dd = clean.substring(0, 2);
        const mm = clean.substring(2, 4);
        const yy = clean.substring(4, 6);
        return `${dd}${mm}20${yy}`;
    }

    return clean;
}

function getDateParts(
    date: Date,
    formatter: Intl.DateTimeFormat
): Record<string, string> {
    return formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
}

const kyivDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
});

export function getKyivDateParts(date: Date) {
    const parts = getDateParts(date, kyivDateTimeFormatter);
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second)
    };
}

export function createKyivDate(
    year: number,
    month: number,
    day: number,
    hour: number = 0,
    minute: number = 0,
    second: number = 0
): Date {
    const utcGuess = Date.UTC(year, month, day, hour, minute, second);
    const guessDate = new Date(utcGuess);
    const parts = getKyivDateParts(guessDate);
    const kyivRenderedAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
    );

    return new Date(utcGuess - (kyivRenderedAsUtc - utcGuess));
}

export function formatKyivDate(date: Date): string {
    return date.toLocaleDateString('uk-UA', { timeZone: KYIV_TIME_ZONE });
}

export const FINANCE_KEYWORDS = {
    TERMINAL: normalizeFinanceString("термінал"),
    TERMINAL_EN: normalizeFinanceString("terminal"),
    ACQUIRING: normalizeFinanceString("аквайринг"),
    CASH: normalizeFinanceString("готівка"),
    CASH_EN: normalizeFinanceString("cash"),
    CASH_RU: normalizeFinanceString("наличные"),
    INCOME: normalizeFinanceString("виручка"),
    REPORT: normalizeFinanceString("звіт"),
    CASHBOX: normalizeFinanceString("каса")
};
