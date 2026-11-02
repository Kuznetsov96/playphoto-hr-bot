/**
 * «Зубаль Діана Іванівна» → «Зубаль Діана»: у повідомленнях власнику
 * по-батькові лише подовжує рядок (як на екранах вебаппу). Беруться перші
 * два слова; порожнє ім'я лишається порожнім рядком.
 */
export function surnameAndName(fullName: string): string {
    return fullName.trim().split(/\s+/u).slice(0, 2).join(" ");
}

/** Київський календарний день `ДД.ММ` для повідомлень власнику. */
export function formatKyivDayMonth(date: Date | string): string {
    return new Date(date)
        .toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })
        .replace("/", ".");
}

/** Київський час `ГГ:ХХ`. */
export function formatKyivTimeOfDay(date: Date | string): string {
    return new Date(date).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Europe/Kyiv",
    });
}
