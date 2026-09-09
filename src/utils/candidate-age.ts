import type { Location } from "@prisma/client";
import { MAX_CANDIDATE_AGE, MIN_CANDIDATE_AGE } from "../constants/candidate-age-limits.js";

/**
 * Вікові межі кандидатки. Єдині для всіх локацій.
 *
 * До 09.09.2026 Volkland 2 (Запоріжжя) був винятком — 16–28 замість 17–26.
 * Виняток прибрано рішенням власника: межі однакові скрізь. Разом з ним
 * пішла й функція розпізнавання локації за назвою: вона звіряла
 * name/legacyName/sheet регуляркою `/volkland\s*2/i`, тобто правило мовчки
 * ламалося при перейменуванні локації.
 *
 * Самі числа живуть у constants/candidate-age-limits.js — модулі без
 * залежностей, який читає ще й текст відмови. Реекспорт тут лишений, щоб не
 * правити наявні імпорти.
 *
 * Параметр `location` у функціях нижче лишився навмисно: сьогодні він ні на
 * що не впливає, але тримає сигнатуру готовою до наступного винятку — без
 * нього довелося б правити десяток викликів у трьох модулях.
 */
export { MAX_CANDIDATE_AGE, MIN_CANDIDATE_AGE };

export type CandidateAgeRejection = "UNDERAGE" | "AGE_LIMIT";
export type CandidateAgeLocation = Pick<Location, "city" | "name" | "legacyName" | "sheet"> | null | undefined;

export function getCandidateAgeRange(_location?: CandidateAgeLocation): { min: number; max: number } {
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
