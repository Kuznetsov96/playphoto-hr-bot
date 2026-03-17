
/**
 * Unified normalization for Finance Module.
 * Ensures consistent string matching across DDS, Monobank and TechCash.
 */
export function normalizeFinanceString(s: string | null | undefined): string {
    if (!s) return "";
    return s.toLowerCase()
        .replace(/[\s\(\)\-\.]/g, '') // Remove spaces, brackets, dashes, dots
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
