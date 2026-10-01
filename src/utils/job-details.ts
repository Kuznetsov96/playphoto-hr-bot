import type { LocationPay } from "../services/aws-business-client.js";
import type { OpeningHoursDay } from "./location-opening-hours.js";
import { formatLocation, type LocationParts } from "./location-label.js";

/**
 * Блок «Твоя робота» на екрані статусу (рішення власника 01.10.2026, варіант A).
 *
 * До цього блок брав адресу, графік і оплату з захардкодженого
 * location-data-helper.ts: оплата там була російською й розходилась із
 * вебаппом, а для точок поза списком підставлялись вигадані «Гнучкий» і
 * «20-30%». Тепер усе — зі знімка вебаппа (Location.address,
 * LocationOpeningHours, Location.pay), а рядок без даних просто не
 * виводиться: краще промовчати, ніж показати чужу точку чи старі умови.
 *
 * Звертання в блоці немає навмисно: його бачить і кандидатка до рішення
 * («Ваша майбутня робота»), і вже прийнята («Твоя робота»).
 */

const WEEKDAY_SHORT: Record<number, string> = {
    1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб", 7: "Нд",
};

/**
 * «Пн–Пт 10:00–21:00, Сб–Нд 10:00–22:00». Підряд ідучі дні з однаковим часом
 * зливаються в діапазон, одиночний день — «Ср 10:00–21:00». Закритий день у
 * даних відсутній і розриває діапазон: «Пн–Вт …, Чт–Пт …», а не «Пн–Пт».
 * Повертає null, коли годин не задано.
 */
export function formatOpeningHours(days: readonly OpeningHoursDay[] | null | undefined): string | null {
    if (!days?.length) return null;

    const sorted = [...days]
        .filter((day) => WEEKDAY_SHORT[day.dayOfWeek] !== undefined)
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek);

    const groups: Array<{ from: number; to: number; opens: string; closes: string }> = [];
    for (const day of sorted) {
        const last = groups[groups.length - 1];
        if (last && last.to + 1 === day.dayOfWeek && last.opens === day.opens && last.closes === day.closes) {
            last.to = day.dayOfWeek;
        } else {
            groups.push({ from: day.dayOfWeek, to: day.dayOfWeek, opens: day.opens, closes: day.closes });
        }
    }
    if (groups.length === 0) return null;

    return groups
        .map((group) => {
            const label = group.from === group.to
                ? WEEKDAY_SHORT[group.from]
                : `${WEEKDAY_SHORT[group.from]}–${WEEKDAY_SHORT[group.to]}`;
            return `${label} ${group.opens}–${group.closes}`;
        })
        .join(", ");
}

/** Відсоток без зайвих нулів: 25 → «25», 22.5 → «22.5», 22.50 → «22.5». */
export function formatPercent(value: number): string {
    return String(Number(value.toFixed(2)));
}

/** Гривні цілим числом із пробілом між тисячами: 1000 → «1 000». */
export function formatHryvnias(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
}

/**
 * «25 % від виручки в будні, 30 % у вихідні; удвох — 18 %». Парна частина —
 * лише коли парний відсоток задано (0 = не задано). Повертає null без умов.
 */
export function formatPayLine(pay: LocationPay | null | undefined): string | null {
    if (!pay) return null;
    const { weekdayPercent, weekendPercent, weekdayPairPercent, weekendPairPercent } = pay;
    if (weekdayPercent <= 0 && weekendPercent <= 0) return null;

    const base = weekdayPercent === weekendPercent
        ? `${formatPercent(weekdayPercent)} % від виручки щодня`
        : `${formatPercent(weekdayPercent)} % від виручки в будні, ${formatPercent(weekendPercent)} % у вихідні`;

    let pair = "";
    if (weekdayPairPercent > 0 && weekendPairPercent > 0) {
        pair = weekdayPairPercent === weekendPairPercent
            ? `; удвох — ${formatPercent(weekdayPairPercent)} %`
            : `; удвох — ${formatPercent(weekdayPairPercent)} % у будні, ${formatPercent(weekendPairPercent)} % у вихідні`;
    } else if (weekdayPairPercent > 0) {
        // Пара задана лише на один бік тижня — називаємо, на який.
        pair = `; удвох — ${formatPercent(weekdayPairPercent)} % у будні`;
    } else if (weekendPairPercent > 0) {
        pair = `; удвох — ${formatPercent(weekendPairPercent)} % у вихідні`;
    }

    return `${base}${pair}`;
}

/** «500 грн у будні, 700 грн у вихідні» або «500 грн щодня». null без гарантії. */
export function formatGuaranteeLine(pay: LocationPay | null | undefined): string | null {
    if (!pay) return null;
    const { weekdayGuarantee, weekendGuarantee } = pay;
    if (weekdayGuarantee <= 0 && weekendGuarantee <= 0) return null;
    if (weekdayGuarantee === weekendGuarantee) return `${formatHryvnias(weekdayGuarantee)} грн щодня`;
    return `${formatHryvnias(weekdayGuarantee)} грн у будні, ${formatHryvnias(weekendGuarantee)} грн у вихідні`;
}

const PAY_KEYS = [
    "weekdayPercent",
    "weekendPercent",
    "weekdayPairPercent",
    "weekendPairPercent",
    "weekdayGuarantee",
    "weekendGuarantee",
] as const;

/**
 * Json-колонка Location.pay назад у типізовані умови. Знімок уже пройшов
 * схему, але колонка — це лише Json: неповний чи чужий запис вважаємо
 * відсутнім, а не малюємо «undefined %».
 */
export function readLocationPay(value: unknown): LocationPay | null {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const key of PAY_KEYS) {
        if (typeof record[key] !== "number" || !Number.isFinite(record[key])) return null;
    }
    return record as unknown as LocationPay;
}

function escapeHtml(text: string): string {
    return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export type JobDetailsLocation = LocationParts & {
    address?: string | null;
    openingHours?: readonly OpeningHoursDay[] | null;
    pay?: unknown;
};

/**
 * Тіло блоку: назва точки й лише ті рядки, для яких є дані. Без жодного
 * рядка даних — null, і екран статусу не показує блок узагалі.
 */
export function buildJobDetailsText(location: JobDetailsLocation | null | undefined): string | null {
    if (!location) return null;

    const pay = readLocationPay(location.pay);
    const address = location.address?.trim();
    const hours = formatOpeningHours(location.openingHours);
    const payLine = formatPayLine(pay);
    const guarantee = formatGuaranteeLine(pay);
    const lines = [
        address ? `Адреса: ${escapeHtml(address)}` : null,
        hours ? `Години роботи: ${hours}` : null,
        payLine ? `Оплата: ${payLine}` : null,
        guarantee ? `Гарантія за зміну: ${guarantee}` : null,
    ].filter((line): line is string => line !== null);

    if (lines.length === 0) return null;

    return `<b>${escapeHtml(formatLocation(location, "listing"))}</b>\n${lines.join("\n")}`;
}
