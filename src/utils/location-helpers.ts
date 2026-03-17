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

export function getShortLocationName(name?: string | null, city?: string | null): string {
    if (!name) return '—';
    const n = name.toLowerCase();
    const c = (city || '').toLowerCase();

    if (n.includes('smile park')) {
        if (n.includes('darynok') || n.includes('даринок')) return 'SP Даринок';
        if (c.includes('київ')) return 'SP Троєщ';
        return 'SP';
    }
    if (n.includes('fly kids')) return 'FK';
    if (n.includes('dytyache horyshche') || n.includes('горище')) return 'DH';
    if (n.includes('drive city')) return 'Drive';
    if (n.includes('dragon park')) return 'Dragon';
    if (n.includes('leoland') || n.includes('leolend')) return 'Leo';
    if (n.includes('fantasy town')) return 'FT';
    if (n.includes('karamel')) return 'Карамель';
    
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
