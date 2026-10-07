/**
 * Як бот називає дату й час зйомки. Та сама форма, що в касі вебаппа (shoot-label.ts):
 * фотограф впізнає в касі ту саму зйомку, про яку писав бот. Дата — рядок YYYY-MM-DD,
 * тож день тижня рахується через UTC, а не через локальний Date процесу.
 */
const WEEKDAYS = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TEXT_LIMIT = 500;

export type ShootInterval = { start: string; end: string | null };

export function ukWeekday(date: string): string {
    const m = DATE.exec(date);
    if (!m) return "";
    return WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]!;
}

export function dayMonth(date: string): string {
    const m = DATE.exec(date);
    return m ? `${m[3]}.${m[2]}` : date;
}

export function dayLabel(date: string): string {
    return `${ukWeekday(date)} ${dayMonth(date)}`;
}

export function formatIntervals(intervals: readonly ShootInterval[]): string {
    return intervals.map((i) => (i.end === null ? i.start : `${i.start}–${i.end}`)).join(", ");
}

export function formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes} хв`;
    if (minutes % 30 === 0) return `${String(minutes / 60).replace(".", ",")} год`;
    return `${Math.floor(minutes / 60)} год ${minutes % 60} хв`;
}

/** `2030-03-16` → `300316`: шість цифр замість десяти — кнопка влазить у 64 байти. */
export function toYymmdd(date: string): string {
    const m = DATE.exec(date);
    if (!m) throw new Error(`Invalid date: ${date}`);
    return `${m[1]!.slice(2)}${m[2]}${m[3]}`;
}

export function fromYymmdd(value: string): string | null {
    const m = /^(\d{2})(\d{2})(\d{2})$/u.exec(value);
    if (!m) return null;
    const iso = `20${m[1]}-${m[2]}-${m[3]}`;
    const parsed = new Date(`${iso}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * Вільний текст (ім’я, побажання, коментар повернення) — не довше `max` символів з «…».
 * Різати до escapeHtml, а не після: інакше ножиці влучать усередину `&amp;`. Емодзі
 * (пара сурогатів) не розрізається навпіл — Telegram відхиляє такий рядок.
 */
export function clip(text: string, max: number = TEXT_LIMIT): string {
    if (text.length <= max) return text;
    let end = max - 1;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return `${text.slice(0, end)}…`;
}
