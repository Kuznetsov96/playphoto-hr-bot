import type { Location } from "@prisma/client";

export type VacancyPriority = 'URGENT' | 'ACTIVE' | 'FULL';

export function getLocationPriority(neededCount: number): VacancyPriority {
    if (neededCount >= 3) return 'URGENT';
    if (neededCount > 0) return 'ACTIVE';
    return 'FULL';
}

export function getCityCode(city?: string | null): string {
    if (!city) return '??';
    const c = city.toLowerCase();
    if (c.includes('хмельн')) return 'Хм';
    if (c.includes('київ')) return 'Кв';
    if (c.includes('львів')) return 'Лв';
    if (c.includes('харк')) return 'Хк';
    if (c.includes('рівн')) return 'Рв';
    if (c.includes('черк')) return 'Чк';
    if (c.includes('запор')) return 'Зп';
    if (c.includes('колом')) return 'Кл';
    if (c.includes('самб')) return 'См';
    if (c.includes('шепт')) return 'Шп';
    return city.substring(0, 2);
}

/**
 * A compact venue label for rows that are already crowded — HR and mentor candidate lists, the
 * hiring-needs board — where the full name would push out the candidate's own name.
 *
 * `branch` is what distinguishes same-named venues and must be passed whenever it is known.
 * An earlier version derived the discriminator from the name, which worked only while the
 * catalogue spelled them "Volkland 2 (Шевчик)". Once all three became a plain "Volkland" with
 * the difference held in `branch`, the digit search found nothing and fell through to
 * "Volkland 1" for all of them — two of which were simply wrong.
 *
 * @example ("Smile Park", "Київ", "Троєщина") -> "SP Троєщина"
 * @example ("Kidlandia", "Київ", null) -> "Kidlandia"
 */
export function getShortLocationName(
    name?: string | null,
    _city?: string | null,
    branch?: string | null
): string {
    if (!name) return '—';

    const abbreviated = abbreviateVenue(name);
    const trimmedBranch = branch?.trim();

    return trimmedBranch ? `${abbreviated} ${trimmedBranch}` : abbreviated;
}

/**
 * Shortens the venue name alone. Only names that actually crowd a row are abbreviated; anything
 * unrecognised keeps its first word, which is short enough already.
 */
function abbreviateVenue(name: string): string {
    const n = name.toLowerCase();

    // "Dragon Park" and "Dragon Park 2" are two Lviv venues told apart by the name itself, so the
    // trailing number is part of the identity here rather than an invented discriminator.
    if (n.includes('dragon park')) return n.includes('2') ? 'Dragon 2' : 'Dragon';

    if (n.includes('smile park')) return 'SP';
    if (n.includes('fly kids')) return 'FK';
    if (n.includes('dytyache horyshche') || n.includes('dytiache horyshche') || n.includes('горище')) return 'DH';
    if (n.includes('drive city')) return 'Drive';
    if (n.includes('leoland') || n.includes('leolend')) return 'Leo';
    if (n.includes('fantasy town')) return 'FT';
    if (n.includes('karamel') || n.includes('карамель')) return 'Карамель';
    if (n.includes('volkland')) return 'Volkland';

    return name.split(' ')[0] || name;
}

export function getPriorityEmoji(priority: VacancyPriority): string {
    switch (priority) {
        case 'URGENT': return '🔴';
        case 'ACTIVE': return ''; // Normal state - no emoji (Apple Style)
        case 'FULL': return '⏸️'; // Paused/Waitlist only
    }
}

export function getPriorityLabel(neededCount: number): string {
    const priority = getLocationPriority(neededCount);
    const emoji = getPriorityEmoji(priority);
    
    switch (priority) {
        case 'URGENT': return `${emoji} Критично (${neededCount})`;
        case 'ACTIVE': return `Активно (${neededCount})`;
        case 'FULL': return `${emoji} Reserve`;
    }
}
