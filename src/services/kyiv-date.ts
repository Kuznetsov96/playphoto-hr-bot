/**
 * Utilities for working with dates in Kyiv timezone (Europe/Kyiv, UTC+2/+3).
 * Used for bucketing shifts and other operations that must respect local calendar days.
 */

export function kyivStartOfDay(date: Date): Date {
    const key = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Kyiv",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
    return new Date(`${key}T00:00:00.000Z`);
}

export function nextKyivDay(date: Date): Date {
    return new Date(kyivStartOfDay(date).getTime() + 24 * 60 * 60 * 1000);
}
