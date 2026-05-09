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
