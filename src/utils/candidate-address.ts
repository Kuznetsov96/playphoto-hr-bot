import { formatCityUk } from "./location-label.js";

/**
 * Рядок адреси під назвою точки на екрані вибору локації в анкеті.
 *
 * Раніше бралась друга частина адреси після коми: губились номер будинку,
 * ТЦ і населений пункт. Shark Park показувався як «вул. Дорошенка» — без
 * Софіївської Борщагівки, тож кандидатка бачила Київ там, де його немає.
 * А в адресі без міста попереду (Volkland, Миргород: «вул. Панаса
 * Мирного, 14») на екран потрапляло саме «14».
 *
 * Тепер — уся адреса з картки вебаппа, без міста на початку: місто
 * кандидатка щойно обрала сама. Місто знімається, лише коли перша частина
 * адреси ним і є (укр. назва з довідника, латиниця з бази, «м. Київ»);
 * інакше адреса лишається як є. Повертає звичайний текст, не HTML.
 */
export function formatCandidateAddress(
    address: string | null | undefined,
    city: string | null | undefined,
    cityUk?: string | null,
): string {
    const full = (address ?? "").replace(/\s+/g, " ").trim();
    if (!full) return "";

    const comma = full.indexOf(",");
    if (comma === -1) return full;

    const head = normalize(full.slice(0, comma).replace(/^м\.?\s*/i, ""));
    const rest = full.slice(comma + 1).trim();
    if (!rest) return full;

    const names = new Set(
        [city, cityUk, city ? formatCityUk(city, cityUk ?? undefined) : null]
            .filter((name): name is string => !!name && !!name.trim())
            .map(normalize),
    );

    return names.has(head) ? rest : full;
}

function normalize(value: string): string {
    return value.normalize("NFC").replace(/[’ʼ']/g, "'").trim().toLocaleLowerCase("uk-UA");
}

export type CandidateLocationScreenItem = {
    name: string;
    branch?: string | null;
    city: string;
    cityUk?: string | null;
    address?: string | null;
    googleMapsLink?: string | null;
};

/**
 * Текст екрана вибору точки (HTML для Telegram): номер, назва жирним,
 * під нею адреса курсивом і «на мапі». Чиста функція — щоб екран
 * перевірявся тестом на реальних адресах, без запуску бота.
 */
export function buildLocationSelectionText(
    intro: string,
    locations: readonly CandidateLocationScreenItem[],
    formatName: (location: CandidateLocationScreenItem) => string,
): string {
    let text = intro + "\n\n";
    locations.forEach((l, i) => {
        const street = escapeHtml(formatCandidateAddress(l.address, l.city, l.cityUk));
        const name = escapeHtml(formatName(l));
        const maps = l.googleMapsLink
            ? ` (<a href="${escapeHtml(l.googleMapsLink).replace(/"/g, "&quot;")}">на мапі</a>)`
            : "";
        // Без адреси рядка-курсиву немає: порожній <i></i> лишав «дірку» під назвою.
        const details = street ? `\n<i>${street}</i>${maps}` : (maps ? `\n${maps.trim()}` : "");
        text += `${i + 1}. <b>${name}</b>${details}\n\n`;
    });
    return text;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
