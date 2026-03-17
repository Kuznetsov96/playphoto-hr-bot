export function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(0));

    // Increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i]![0] = i;
    }

    // Increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0]![j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i]![j] = matrix[i - 1]![j - 1]!;
            } else {
                matrix[i]![j] = Math.min(
                    matrix[i - 1]![j - 1]! + 1, // substitution
                    Math.min(
                        matrix[i]![j - 1]! + 1, // insertion
                        matrix[i - 1]![j]! + 1 // deletion
                    )
                );
            }
        }
    }

    return matrix[b.length]![a.length]!;
}

export function isFuzzyMatch(text: string, query: string, threshold: number = 2): boolean {
    const normalizedText = text.toLowerCase();
    const normalizedQuery = query.toLowerCase();

    // 1. Direct substring match (covers strict containment)
    if (normalizedText.includes(normalizedQuery)) return true;

    // 2. Token-based matching
    const textTokens = normalizedText.split(/\s+/);
    const queryTokens = normalizedQuery.split(/\s+/);

    // For every token in query, try to find a "close enough" token in text
    return queryTokens.every(qToken => {
        return textTokens.some(tToken => {
            // Precise match
            if (tToken === qToken) return true;

            // Substring match for incomplete words (e.g. "Vital" matches "Vitalii")
            if (tToken.includes(qToken)) return true;

            // Levenshtein (only if token is long enough to justify typos)
            if (qToken.length > 3 && tToken.length > 3) {
                return levenshteinDistance(qToken, tToken) <= threshold;
            }
            return false;
        });
    });
}

/**
 * Shortens a full name to "Surname Name" (first two words)
 */
export function shortenName(fullName: string): string {
    if (!fullName) return "Невідомо";
    const parts = fullName.trim().split(/\s+/);
    if (parts.length <= 2) return fullName.trim();
    return `${parts[0]} ${parts[1]}`;
}

/**
 * Extracts only the first name from a full name.
 * Handles:
 * - "Surname Name" (returns Name)
 * - "Name Surname" (returns Name)
 */
export function extractFirstName(fullName: string): string {
    if (!fullName || fullName.toLowerCase().includes("unknown")) return "";
    
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return parts[0]!;
    
    if (parts.length >= 2) {
        const p1 = parts[0]!;
        const p2 = parts[1]!;
        const p1Low = p1.toLowerCase();
        const p2Low = p2.toLowerCase();
        
        const isSurname = (s: string) => 
            s.endsWith('ко') || s.endsWith('ук') || s.endsWith('юк') || 
            s.endsWith('ов') || s.endsWith('ова') || s.endsWith('ін') || 
            s.endsWith('іна') || s.endsWith('ич') || s.endsWith('ий') || 
            s.endsWith('ая') || s.endsWith('єва') || s.endsWith('ська') || 
            s.endsWith('цький') || s.endsWith('енко') || s.endsWith('цька') ||
            s.endsWith('ський') || s.endsWith('чук') || s.endsWith('цюк') ||
            s.endsWith('шин') || s.endsWith('шина') || s.endsWith('ик');

        // Пріоритет: якщо перше слово схоже на прізвище, а друге - ні, беремо друге.
        if (isSurname(p1Low) && !isSurname(p2Low)) return p2;
        // Навпаки
        if (isSurname(p2Low) && !isSurname(p1Low)) return p1;
        
        // Якщо обидва слова не схожі на прізвища (або обидва схожі), 
        // беремо перше, але ТІЛЬКИ якщо воно коротке (імена рідко довші за 10-12 літер)
        if (p1.length <= 12) return p1;
    }
    
    return "";
}

    export function formatCompactName(fullName?: string | null): string {
        if (!fullName) return "Кандидатка";
        const parts = fullName.trim().split(/\s+/);
        return parts[0] || "Кандидатка";
    }

    /**
     * Calculates age based on a birthDate (Date or ISO string)
     */    export function calculateAge(birthDate: Date | string | null): number | string {
    if (!birthDate) return "?";
    const dob = new Date(birthDate);
    if (isNaN(dob.getTime())) return "?";
    const diffMs = Date.now() - dob.getTime();
    const ageDate = new Date(diffMs);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
    }
