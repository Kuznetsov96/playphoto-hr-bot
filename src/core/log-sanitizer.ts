const MAX_LOG_TEXT_LENGTH = 160;

function truncate(value: string): string {
    if (value.length <= MAX_LOG_TEXT_LENGTH) return value;
    return `${value.slice(0, MAX_LOG_TEXT_LENGTH)}...`;
}

/**
 * Кандидат у телефони: 10–13 цифр з одиночними пробілами, дефісами чи дужками між ними,
 * необов’язковий «+» спереду. Двокрапка, крапка й тире не входять — час «15:00–16:00» і дата
 * «19.03.2030» не склеюються в один номер.
 */
const PHONE_CANDIDATE = /(?<![\d+])\+?\(?\d(?:[ ()-]{0,2}\d){9,12}(?!\d)/gu;

/**
 * Телефон → «…1301», як maskPhone вебаппа. Номером вважаємо запис із «+», голі 10–13 цифр
 * або запис, що починається з 0 чи 380; список сум через пробіл («1600 1200 3000») — ні.
 */
function maskPhones(value: string): string {
    return value.replace(PHONE_CANDIDATE, (match) => {
        const digits = match.replace(/\D/gu, "");
        const phoneLike = match.startsWith("+") || /^\d+$/u.test(match) || /^\(?(0|380)/u.test(match);
        return phoneLike ? `…${digits.slice(-4)}` : match;
    });
}

/** Маскування до обрізання: інакше ножиці на 160-му символі лишили б початок номера. */
export function sanitizeTextForLogs(value?: string | null): string | null {
    if (!value) return null;
    return truncate(maskPhones(value.replace(/\s+/g, " ").trim()));
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
