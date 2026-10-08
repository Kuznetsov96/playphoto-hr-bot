import { normalizeCity } from "./location-label.js";

/**
 * Чисті правила постійної теми підтримки (spec 2026-10-08): назва, статус-іконка,
 * коротка подяка, закріплена картка. Без Telegram і без бази — щоб правила
 * перевірялись тестами напряму.
 */

/** Локальна копія: модуль чистий і не тягне handlers/admin з grammY. */
function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type ThreadStatus = "WAITING" | "ANSWERED" | "ESCALATED" | "ARCHIVED";

export type ThreadState = { status: ThreadStatus; escalatedToTelegramId: bigint | null };

export type ThreadEvent =
    | { kind: "staff_question" }
    | { kind: "staff_ack" }
    | { kind: "support_reply"; actorTelegramId: bigint }
    | { kind: "support_thumbs_up"; actorTelegramId: bigint }
    | { kind: "bot_context" }
    | { kind: "archived" }
    | { kind: "reactivated" }
    | { kind: "escalated"; targetTelegramId: bigint }
    | { kind: "back_to_support"; hasUnansweredQuestion: boolean };

/** Назва теми в Telegram не довша за 128 символів. */
const TOPIC_NAME_LIMIT = 128;

export function kyivDay(at: Date): string {
    return at.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
}

/** `2026-10-08` → `08.10` для людських рядків. */
export function shortDay(day: string): string {
    const [, month, date] = day.split("-");
    return `${date}.${month}`;
}

export function surnameOf(fullName: string): string {
    return fullName.trim().split(/\s+/)[0] ?? "";
}

/**
 * Прізвище без ініціалів. Ініціал лише тоді, коли прізвище в когось повторюється:
 * інакше дві теми з однаковою назвою не розрізнити в списку.
 */
export function threadNameLabel(
    staff: { fullName: string; surnameNameDot: string | null },
    collidingSurnames: Set<string>,
): string {
    const surname = surnameOf(staff.fullName);
    if (!collidingSurnames.has(surname)) return surname;
    if (staff.surnameNameDot?.trim()) return staff.surnameNameDot.trim();
    const firstName = staff.fullName.trim().split(/\s+/)[1];
    return firstName ? `${surname} ${firstName[0]}.` : surname;
}

/** `Kyiv · Smile Park Darynok`. Місто з каталогу вже латиницею; кирилицю перекладає normalizeCity. */
export function formatThreadPlace(location: { name: string; branch: string | null; city: string }): string {
    const rawCity = location.city.trim();
    const city = /^[A-Za-z][A-Za-z\s'-]*$/.test(rawCity) ? rawCity : normalizeCity(rawCity);
    const venue = location.branch?.trim() ? `${location.name.trim()} ${location.branch.trim()}` : location.name.trim();
    return `${city} · ${venue}`;
}

/** Найчастіша точка змін; нічия — та, що трапилась раніше; без змін — точка профілю. */
export function pickMainLocationId(shifts: { locationId: string }[], fallbackId: string | null): string | null {
    const counts = new Map<string, number>();
    for (const shift of shifts) counts.set(shift.locationId, (counts.get(shift.locationId) ?? 0) + 1);
    let best: string | null = null;
    let bestCount = 0;
    for (const [locationId, count] of counts) {
        if (count > bestCount) {
            best = locationId;
            bestCount = count;
        }
    }
    return best ?? fallbackId;
}

export function buildThreadTitle(nameLabel: string, place: string | null): string {
    const title = place ? `${nameLabel} · ${place}` : nameLabel;
    return title.length > TOPIC_NAME_LIMIT ? title.slice(0, TOPIC_NAME_LIMIT) : title;
}

/**
 * Слова, з яких складається «дякую, добре». Набір перевірено на останніх словах
 * фотографинь у розмовах за вересень–жовтень 2026.
 */
const ACK_WORDS = new Set([
    "дякую", "дякуємо", "дяки", "спасибі", "спасибо", "мерсі", "велике", "дуже", "вам", "тобі", "вас",
    "добре", "гаразд", "ок", "окей", "ok", "okay", "ясно", "зрозуміла", "зрозумів", "зрозуміло", "прийнято",
    "навзаєм", "взаємно", "теж", "і", "та", "супер", "чудово", "класно", "так", "угу", "ага",
]);
const MAX_ACK_WORDS = 3;

type AckInput = {
    text?: string;
    caption?: string;
    sticker?: unknown;
    photo?: unknown;
    video?: unknown;
    document?: unknown;
    voice?: unknown;
    video_note?: unknown;
    audio?: unknown;
    animation?: unknown;
};

/**
 * Коротка подяка або згода, яка не потребує відповіді: до трьох слів, без «?»,
 * лише слова зі словника; або лише емодзі, «+», стікер. Медіа — завжди питання:
 * фото з підписом «дякую» — це звіт, а не подяка.
 */
export function isAcknowledgement(message: AckInput): boolean {
    if (message.sticker) return true;
    if (message.photo || message.video || message.document || message.voice || message.video_note || message.audio || message.animation) {
        return false;
    }
    const raw = message.text?.trim();
    if (!raw) return false;
    if (raw.includes("?")) return false;

    const words = raw
        .toLowerCase()
        .replace(/[’'`]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);

    if (words.length === 0) return true; // лише емодзі, «+», «)»
    if (words.length > MAX_ACK_WORDS) return false;
    return words.every(word => ACK_WORDS.has(word));
}

export function nextStatus(current: ThreadState, event: ThreadEvent): ThreadState {
    switch (event.kind) {
        case "staff_question":
            return current.status === "ESCALATED" ? current : { status: "WAITING", escalatedToTelegramId: null };
        case "staff_ack":
            return current;
        case "bot_context":
            return current.status === "ESCALATED" ? current : { status: "WAITING", escalatedToTelegramId: null };
        case "support_reply":
        case "support_thumbs_up":
            // З архіву виводить лише її власне повідомлення, не відповідь команди.
            if (current.status === "ARCHIVED") return current;
            if (current.status === "ESCALATED" && current.escalatedToTelegramId !== event.actorTelegramId) return current;
            return { status: "ANSWERED", escalatedToTelegramId: null };
        case "escalated":
            return { status: "ESCALATED", escalatedToTelegramId: event.targetTelegramId };
        case "back_to_support":
            return { status: event.hasUnansweredQuestion ? "WAITING" : "ANSWERED", escalatedToTelegramId: null };
        case "archived":
            return { status: "ARCHIVED", escalatedToTelegramId: null };
        case "reactivated":
            return current.status === "ARCHIVED" ? { status: "ANSWERED", escalatedToTelegramId: null } : current;
    }
}

export type ThreadCardInput = {
    today: { day: string; place: string | null; time: string | null } | null;
    archivedAt: string | null;
    fullName: string;
    username: string | null;
    phone: string | null;
    mainPlace: string | null;
};

/**
 * Закріплена картка. Перший рядок телефон показує смужкою зверху теми — тому там
 * сьогоднішня точка, а не «основна»: менеджерці на бігу потрібне саме сьогодні.
 */
export function renderThreadCard(input: ThreadCardInput): string {
    const lines: string[] = [];
    if (input.archivedAt) {
        lines.push(`📦 Employment ended · ${input.archivedAt}`);
    } else if (input.today) {
        const where = input.today.place
            ? [escapeHtml(input.today.place), input.today.time].filter(Boolean).join(" · ")
            : "no shift";
        lines.push(`📍 Today ${input.today.day}: ${where}`);
    }
    lines.push(`👤 ${escapeHtml(input.fullName)}${input.username ? ` · @${escapeHtml(input.username)}` : ""}`);
    if (input.phone) lines.push(`📞 <code>${escapeHtml(input.phone)}</code>`);
    if (input.mainPlace) lines.push(`🏠 Main point: ${escapeHtml(input.mainPlace)}`);
    return lines.join("\n");
}

/** Що з повідомлення має сенс пересилати людині; решта — службове або непідтримуване. */
const RELAYABLE_KEYS = [
    "text", "photo", "video", "document", "voice", "video_note", "audio", "animation", "sticker",
    "contact", "location", "venue", "poll", "dice", "rich_message", "checklist",
] as const;

export function isRelayable(message: object): boolean {
    const record = message as unknown as Record<string, unknown>;
    return RELAYABLE_KEYS.some(key => record[key] !== undefined);
}
