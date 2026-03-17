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

export const CHAT_ID_TO_NAME: Record<number, string> = {
    [-1002323329492]: "Khmelnytskyi Team",
    [-1002378901316]: "Lviv Fly Kids",
    [-1003068768533]: "Lviv Smile Park",
    [-1001956336405]: "Lviv Leoland",
    [-1001933184668]: "Lviv Drive City",
    [-1002571420646]: "Lviv Dragon Park",
    [-1002429009554]: "Kyiv SP Darynok",
    [-1002373731296]: "Kyiv SP Kyiv",
    [-1002625052844]: "Kyiv FK Kyiv",
    [-1002331115725]: "ZP Volkland 1",
    [-1002695718575]: "ZP Volkland 2",
    [-1003005306666]: "ZP Volkland 3",
    [-1002292905493]: "Cherkasy Team",
    [-1003453458076]: "Rivne Team",
    [-1003043444121]: "Sambir Team",
    [-1002425476970]: "Kolomyya Team",
    [-1002446398843]: "Sheptytskyi Team",
    [-1002649143773]: "Kharkiv Team"
};

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function msgToHtml(text: string, entities: any[] = []): string {
    if (!entities || entities.length === 0) return escapeHtml(text);

    // Create a list of all markers (open/close tags)
    interface Marker {
        offset: number;
        type: string;
        isClose: boolean;
        priority: number;
        url?: string;
    }

    const markers: Marker[] = [];

    for (const entity of entities) {
        // Priorities ensure correct nesting: close tags first, then open tags
        // For same position: closing tags should have higher priority (processed first)
        markers.push({ offset: entity.offset, type: entity.type, isClose: false, priority: 2, url: entity.url });
        markers.push({ offset: entity.offset + entity.length, type: entity.type, isClose: true, priority: 1 });
    }

    // Sort markers by offset, then by priority (close tags at same offset first)
    markers.sort((a, b) => {
        if (a.offset !== b.offset) return a.offset - b.offset;
        return a.priority - b.priority;
    });

    let result = "";
    let lastPos = 0;

    for (const marker of markers) {
        // Add text between last marker and current marker
        if (marker.offset > lastPos) {
            result += escapeHtml(text.slice(lastPos, marker.offset));
            lastPos = marker.offset;
        }

        const tagMap: Record<string, string> = {
            bold: "b",
            italic: "i",
            underline: "u",
            strikethrough: "s",
            code: "code",
            pre: "pre",
            blockquote: "blockquote",
            expandable_blockquote: "blockquote",
            spoiler: "tg-spoiler",
        };

        const tag = tagMap[marker.type];
        if (marker.isClose) {
            if (tag) result += `</${tag}>`;
            else if (marker.type === "text_link") result += "</a>";
        } else {
            if (tag) result += `<${tag}>`;
            else if (marker.type === "text_link") {
                const escapedUrl = marker.url?.replace(/"/g, '&quot;') || "";
                result += `<a href="${escapedUrl}">`;
            }
        }
    }

    // Add remaining text
    result += escapeHtml(text.slice(lastPos));
    return result;
}

/**
 * Cleans up raw location names from DDS/Technical prefixes
 * and formats them as "Name (City)"
 * @example "Выручка от продаж Leolend (Lviv)" -> "Leolend (Lviv)"
 */
export function formatLocationName(rawName: string, city: string): string {
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

    // 2.6 Normalize "Volkland" (without number) to "Volkland 1"
    nfcClean = nfcClean.replace(/\bVolkland\b(?!\s*\d)/gi, 'Volkland 1');

    // Final cleanup of extra spaces or empty parentheses
    const finalClean = nfcClean
        .replace(/\s*\(\s*\)\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 3. Final format: "Location (City)" with English city name
    const englishCity = normalizeCity(cityNoEmoji);
    return `${finalClean} (${englishCity})`;
}
