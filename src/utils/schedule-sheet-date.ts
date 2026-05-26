const MONTHS: Record<string, number> = {
    "янв": 0, "фев": 1, "мар": 2, "апр": 3, "май": 4, "июн": 5,
    "июл": 6, "авг": 7, "сен": 8, "окт": 9, "ноя": 10, "дек": 11,
    "січ": 0, "лют": 1, "бер": 2, "кві": 3, "тра": 4, "чер": 5,
    "лип": 6, "сер": 7, "вер": 8, "жов": 9, "лис": 10, "гру": 11,
};

export function parseScheduleSheetYear(sheetName?: string, fallbackYear: number = new Date().getFullYear()): number {
    const match = String(sheetName || "").match(/\b(20\d{2})\b/);
    return match ? Number(match[1]) : fallbackYear;
}

export function parseScheduleMonth(monthStr: string): number {
    const normalized = monthStr.trim().toLowerCase();
    for (const [key, val] of Object.entries(MONTHS)) {
        if (normalized.startsWith(key)) return val;
    }
    return new Date().getMonth();
}

export function parseScheduleHeaderDate(value: string, sheetName?: string): Date | null {
    const str = value.trim().toLowerCase();
    if (!str) return null;

    const year = parseScheduleSheetYear(sheetName);
    if (str.includes(",")) {
        const parts = str.split(",");
        const day = parseInt(parts[0] || "");
        const month = parseScheduleMonth((parts[1] || "").trim());
        if (!isNaN(day)) return new Date(year, month, day);
    }

    if (str.includes(".")) {
        const parts = str.split(".");
        const day = parseInt(parts[0] || "");
        const month = parseInt(parts[1] || "");
        if (!isNaN(day) && !isNaN(month)) return new Date(year, month - 1, day);
    }

    return null;
}
