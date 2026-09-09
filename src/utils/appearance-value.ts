/**
 * Значення поля appearance у чистому вигляді.
 *
 * До 09.09.2026 до нього дописувався рядок «(Обрані локації: …)», якщо
 * кандидатка позначила кілька локацій. Поле читають два рішення —
 * resolveScreeningStatus і underage-reactivation-service, — і обидва
 * порівнюють його з «Без особливостей». Через дописку кандидатка без
 * татуювань виглядала як така, що потребує ручного огляду зовнішності.
 *
 * Нові анкети пишуть локації в Candidate.additionalLocationIds, але в базі
 * лишилися старі рядки, тож дописку треба вміти зрізати при читанні. Прибрати
 * цей хелпер можна буде лише після міграції даних, а не разом із кодом, який
 * дописку створював.
 */
const LEGACY_LOCATION_SUFFIX = /\n?\(Обрані локації:[^)]*\)\s*$/;

export function stripLegacyLocationSuffix(appearance: string | null | undefined): string {
    if (!appearance) return "";
    return appearance.replace(LEGACY_LOCATION_SUFFIX, "").trim();
}

/** Чи потрібен ручний огляд зовнішності за значенням поля. */
export function appearanceNeedsReview(appearance: string | null | undefined): boolean {
    const value = stripLegacyLocationSuffix(appearance);
    if (!value) return false;
    return value.includes("[Фото]") || value !== "Без особливостей";
}
