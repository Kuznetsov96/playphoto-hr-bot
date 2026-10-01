const MAX_LOG_TEXT_LENGTH = 160;

function truncate(value: string): string {
    if (value.length <= MAX_LOG_TEXT_LENGTH) return value;
    return `${value.slice(0, MAX_LOG_TEXT_LENGTH)}...`;
}

export function sanitizeTextForLogs(value?: string | null): string | null {
    if (!value) return null;
    return truncate(value.replace(/\s+/g, " ").trim());
}

export function sanitizeCallbackData(value?: string | null): string | null {
    if (!value) return null;
    const exactSafeActions = new Set([
        "no_slots_fit",
        "no_slots_available_ack",
        "training_no_slots_fit",
        "start_scheduling",
        "start_training_scheduling"
    ]);
    if (exactSafeActions.has(value)) return value;

    // Підписана кнопка cb:<код>:<payload>:<підпис> — код лишаємо, payload
    // (id слота) і підпис ні. Раніше в лог ішло голе «cb», і «Змінити час»,
    // «Скасувати запис», «Не планую продовжувати» були нерозрізнені — аудит
    // 01.10.2026 не зміг побачити, де саме кандидатки тиснуть двічі.
    const signed = value.match(/^cb:([a-z0-9]+):/i);
    if (signed) return `cb:${signed[1]}`;

    // Кнопка grammy-меню: <menuId>/<рядок>/<стовпчик>/<payload>/<відбиток>.
    // Відбиток — бінарне сміття в логах; меню й позиція кажуть, що натиснули.
    const menu = value.match(/^([a-z0-9-]+)\/(\d+)\/(\d+)\//i);
    if (menu) return `${menu[1]}/${menu[2]}/${menu[3]}`;

    const action = value.split(":")[0]?.split("_").slice(0, 3).join("_") || value;
    return truncate(action);
}

export function sanitizeChatLogEntry(contentType: string, value?: string | null): string | null {
    if (!value) return null;

    if (contentType === "contact") return "[CONTACT_REDACTED]";
    if (contentType === "location") return "[LOCATION_REDACTED]";
    if (contentType === "callback") return sanitizeCallbackData(value);

    return sanitizeTextForLogs(value);
}
