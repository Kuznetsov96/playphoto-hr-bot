/**
 * How a location is named to a human, in one place.
 *
 * Kept free of `grammy` and of the context type on purpose: this is imported by candidate menus,
 * services and dispatchers alike, and pulling the admin handler chain into each of them made the
 * heaviest test in the suite tip over its timeout.
 */

export const CITY_MAP: Record<string, string> = {
    // English targets
    "Lviv": "Lviv",
    "Kyiv": "Kyiv",
    "Kolomyya": "Kolomyya",
    "Kolomyia": "Kolomyya",
    "Khmelnytskyi": "Khmelnytskyi",
    "Zaporizhzhia": "Zaporizhzhia",
    "ZP": "Zaporizhzhia",
    "Cherkasy": "Cherkasy",
    "Rivne": "Rivne",
    "Sambir": "Sambir",
    "Sheptytskyi": "Sheptytskyi",
    "Kharkiv": "Kharkiv",
    "Chortkiv": "Chortkiv",
    "Ternopil": "Ternopil",
    // UA keys -> EN
    "Львів": "Lviv",
    "Київ": "Kyiv",
    "Коломия": "Kolomyya",
    "Коломія": "Kolomyya",
    "Хмельницький": "Khmelnytskyi",
    "Запоріжжя": "Zaporizhzhia",
    "Черкаси": "Cherkasy",
    "Рівне": "Rivne",
    "Рівно": "Rivne",
    "Самбір": "Sambir",
    "Шептицький": "Sheptytskyi",
    "Харків": "Kharkiv",
    "Чортків": "Chortkiv",
    "Тернопіль": "Ternopil",
    // Emoji variants -> EN
    "🦁 Lviv": "Lviv",
    "🏛️ Kyiv": "Kyiv",
    "🌸 Kolomyya": "Kolomyya",
    "🌸 Kolomyia": "Kolomyya",
    "⛰️ Khmelnytskyi": "Khmelnytskyi",
    "⚡ Zaporizhzhia": "Zaporizhzhia",
    "🏰 Cherkasy": "Cherkasy",
    "🌲 Rivne": "Rivne",
    "🔮 Sambir": "Sambir",
    "⛪ Sheptytskyi": "Sheptytskyi",
    "🎓 Kharkiv": "Kharkiv",
    "🦇 Chortkiv": "Chortkiv",
    "🌊 Ternopil": "Ternopil"
};

export const normalizeCity = (city: string) => {
    const trimmed = city.trim();
    if (CITY_MAP[trimmed]) return CITY_MAP[trimmed];
    // Fallback: strip emojis and non-alphanumeric (except space) to try and match
    const clean = trimmed.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    return CITY_MAP[clean] || clean;
};

/**
 * Where a location label is being shown, which decides how the city appears.
 *
 * The venue part never varies — DDS cleanup, a city echoed inside the raw name, and the
 * canonical `branch` are handled identically for all three. Only the city differs, so it is the
 * only thing this switches on:
 *
 *   in-city    Fly Kids                  the screen already names the city (a picker scoped to
 *                                        one city, a photographer's schedule)
 *   listing    Fly Kids (Lviv)           a picker or report spanning cities
 *   sentence   Fly Kids, Lviv            prose: notifications, support topics, detail headers
 */
export type LocationDisplayContext = "in-city" | "listing" | "sentence";

export type LocationParts = {
    name?: string | null | undefined;
    city?: string | null | undefined;
    branch?: string | null | undefined;
} | null | undefined;

/**
 * The single location formatter. Renders a venue for a given display context.
 *
 * `branch` is the canonical discriminator for venues sharing a name — the three Zaporizhzhia
 * Volklands are all named "Volkland" and differ only by branch. It reaches the label in every
 * context, so same-named venues never collapse into one indistinguishable row.
 *
 * The rule is "show what the catalogue says distinguishes this venue", not "show enough to be
 * unique in the database". That keeps the label a pure function of one location: it never shifts
 * because an unrelated venue opened elsewhere. When a genuine collision does appear, the
 * catalogue is what should gain a branch — `findShiftLocationLabelCollisions` reports it rather than
 * letting the bot invent a discriminator of its own.
 *
 * @example ({ name: "Выручка от продаж Leolend", city: "Львів" }, "listing") -> "Leolend (Lviv)"
 * @example ({ name: "Volkland", city: "Запоріжжя", branch: "Шевчик" }, "in-city") -> "Volkland (Шевчик)"
 */
export function formatLocation(location: LocationParts, context: LocationDisplayContext): string {
    const rawName = location?.name?.trim();
    if (!rawName) return "Unknown";

    const city = location?.city?.trim();
    const branch = location?.branch?.trim();

    // Without a city there is nothing to strip and nothing to append: every context collapses
    // to the venue on its own.
    if (!city) return branch ? `${rawName} (${branch})` : rawName;

    const venue = formatVenuePart(rawName, city, branch);
    if (context === "in-city") return venue;

    const englishCity = normalizeCity(city.replace(/[^\p{L}\p{N}\s]/gu, '').trim().normalize('NFC'));
    return context === "sentence" ? `${venue}, ${englishCity}` : `${venue} (${englishCity})`;
}

/**
 * Cleans a raw location name and appends the canonical `branch`. The city is only ever removed
 * here — never added — so the caller decides how to show it.
 */
function formatVenuePart(rawName: string, city: string, branch?: string | null): string {
    // 1. Remove common technical prefixes (DDS articles)
    // Supports RU/UA variants: "Выручка от продаж", "Виручка від продажу", "Дохід ", etc.
    let clean = rawName
        .replace(/^(Выручка от продаж|Виручка від продажу|Дохід|Стаття)\s+/i, '')
        .trim();

    // 2. Remove all variants of the city name to avoid "Smile Park Kharkiv (Kharkiv)"
    // or "Карамель Шептицький (Sheptytskyi)".
    const normalizedCityName = normalizeCity(city).normalize('NFC');
    const cityNoEmoji = city.replace(/[^\p{L}\p{N}\s]/gu, '').trim().normalize('NFC');

    const cityVariants = new Set<string>();
    Object.entries(CITY_MAP).forEach(([key, value]) => {
        if (value === normalizedCityName) {
            cityVariants.add(key.replace(/[^\p{L}\p{N}\s]/gu, '').trim().normalize('NFC'));
        }
    });
    cityVariants.add(cityNoEmoji);

    const sortedVariants = Array.from(cityVariants)
        .filter(v => v.length > 2)
        .sort((a, b) => b.length - a.length);

    let nfcClean = clean.normalize('NFC');

    for (const variant of sortedVariants) {
        // More aggressive: remove variant even if it's part of a word or has no boundaries
        // This helps with "КаремельКоломия" or similar cases if they exist
        const variantRegex = new RegExp(`${variant}`, 'gi');
        if (variantRegex.test(nfcClean)) {
            nfcClean = nfcClean.replace(variantRegex, ' ').trim();
        }
    }

    // 2.5 Translate brands and common words to English
    const BRAND_MAP: Record<string, string> = {
        "Карамель": "Karamel",
        "Каремель": "Karamel",
        "Смайл Парк": "Smile Park",
        "СмайлПарк": "Smile Park",
        "Флай Кідс": "Fly Kids",
        "ФлайКідс": "Fly Kids",
        "Леоленд": "Leoland",
        "Драйв Сіті": "Drive City",
        "Драгон Парк": "Dragon Park",
        "Дитяче горище": "Children's Attic",
        "Чортків": "Chortkiv",
        "Самбір": "Sambir",
        "Коломия": "Kolomyya",
        "Шептицький": "Sheptytskyi",
        "Харків": "Kharkiv",
        "Львів": "Lviv",
        "Рівне": "Rivne",
        "Черкаси": "Cherkasy",
        "Запоріжжя": "Zaporizhzhia"
    };

    for (const [ua, en] of Object.entries(BRAND_MAP)) {
        const brandRegex = new RegExp(`${ua}`, 'gi');
        nfcClean = nfcClean.replace(brandRegex, en);
    }

    // 2.6 The canonical `branch` now distinguishes same-named venues. The old rule here
    // rewrote a bare "Volkland" to "Volkland 1", which invented a fact: it turned an unknown
    // branch into a confident and often wrong "1". An unbranded name stays as it is.

    // Final cleanup of extra spaces or empty parentheses
    const finalClean = nfcClean
        .replace(/\s*\(\s*\)\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 3. Guard against the name collapsing to nothing (a raw name that was only the city).
    const venue = finalClean || rawName.trim();

    // 4. Append the canonical branch. The city is the caller's business.
    const trimmedBranch = branch?.trim();
    return trimmedBranch ? `${venue} (${trimmedBranch})` : venue;
}
