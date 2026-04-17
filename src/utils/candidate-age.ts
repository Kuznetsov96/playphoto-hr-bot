export const MIN_CANDIDATE_AGE = 17;
export const MAX_CANDIDATE_AGE = 26;

export type CandidateAgeRejection = "UNDERAGE" | "AGE_LIMIT";

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

export function getAgeRejection(age: number): CandidateAgeRejection | null {
    if (age < MIN_CANDIDATE_AGE) return "UNDERAGE";
    if (age > MAX_CANDIDATE_AGE) return "AGE_LIMIT";
    return null;
}

export function getBirthDateRejection(birthDate?: Date | string | null): CandidateAgeRejection | null {
    if (!birthDate) return null;

    const date = birthDate instanceof Date ? birthDate : new Date(birthDate);
    if (Number.isNaN(date.getTime())) return null;

    return getAgeRejection(getCandidateAge(date));
}
