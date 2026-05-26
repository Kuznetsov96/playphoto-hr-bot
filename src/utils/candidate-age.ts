import type { Location } from "@prisma/client";

export const MIN_CANDIDATE_AGE = 17;
export const MAX_CANDIDATE_AGE = 26;
export const MIN_VOLKLAND_2_ZP_CANDIDATE_AGE = 16;
export const MAX_VOLKLAND_2_ZP_CANDIDATE_AGE = 28;

export type CandidateAgeRejection = "UNDERAGE" | "AGE_LIMIT";
export type CandidateAgeLocation = Pick<Location, "city" | "name" | "legacyName" | "sheet"> | null | undefined;

export function isVolkland2Zaporizhzhia(location: CandidateAgeLocation): boolean {
    if (!location || location.city !== "Запоріжжя") return false;

    return [location.name, location.legacyName, location.sheet]
        .filter((value): value is string => typeof value === "string")
        .some(value => /volkland\s*2/i.test(value));
}

export function getCandidateAgeRange(location?: CandidateAgeLocation): { min: number; max: number } {
    if (isVolkland2Zaporizhzhia(location)) {
        return {
            min: MIN_VOLKLAND_2_ZP_CANDIDATE_AGE,
            max: MAX_VOLKLAND_2_ZP_CANDIDATE_AGE,
        };
    }

    return {
        min: MIN_CANDIDATE_AGE,
        max: MAX_CANDIDATE_AGE,
    };
}

export function getCandidateAge(birthDate: Date | string): number {
    const date = birthDate instanceof Date ? birthDate : new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const monthDelta = today.getMonth() - date.getMonth();

    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate())) {
        age--;
    }

    return age;
}

export function getAgeRejection(age: number, location?: CandidateAgeLocation): CandidateAgeRejection | null {
    const { min, max } = getCandidateAgeRange(location);
    if (age < min) return "UNDERAGE";
    if (age > max) return "AGE_LIMIT";
    return null;
}

export function getBirthDateRejection(birthDate?: Date | string | null, location?: CandidateAgeLocation): CandidateAgeRejection | null {
    if (!birthDate) return null;

    const date = birthDate instanceof Date ? birthDate : new Date(birthDate);
    if (Number.isNaN(date.getTime())) return null;

    return getAgeRejection(getCandidateAge(date), location);
}
