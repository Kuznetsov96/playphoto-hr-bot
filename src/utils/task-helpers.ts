import { kyivDateStr } from "./format-deadline.js";

/**
 * Побудувати прогрес-бар для завдань
 */
export function buildProgressBar(completed: number, total: number): string {
    if (total === 0) return "";

    const barLength = 5;
    const filled = Math.round((completed / total) * barLength);
    const bar = "■".repeat(filled) + "□".repeat(barLength - filled);
    const percent = Math.round((completed / total) * 100);

    return `[${bar}] **${percent}%**`;
}

/**
 * Побудувати календар на 14 днів для вибору дати.
 *
 * Ярлик кнопки (що бачить людина) і callback_data (що піде в базу як робоча
 * дата) мають називати ОДИН і той самий день. Обидва беруться з київської
 * дати одного й того ж моменту (`kyivDateStr`), а не змішують локальний час
 * сервера (UTC у контейнері) з UTC-рядком `toISOString()` — інакше ввечері в
 * Києві (після 21:00 влітку, 22:00 взимку) ярлик і значення розходяться на
 * добу.
 */
export function build14DayCalendar(callbackPrefix: string) {
    const buttons = [];
    const now = new Date();

    let currentRow = [];
    for (let i = 0; i < 14; i++) {
        const instant = new Date(now);
        instant.setUTCDate(instant.getUTCDate() + i);

        const dateStr = kyivDateStr(instant); // YYYY-MM-DD у Києві
        const parts = dateStr.split("-");
        const displayDate = `${parts[2]}.${parts[1]}`;

        const label = i === 0 ? `☀️ Today (${displayDate})` : i === 1 ? `🌅 Tomorrow (${displayDate})` : displayDate;

        currentRow.push({ text: label, callback_data: `${callbackPrefix}${dateStr}` });

        // If row is full (3 items) or it's the last item, push and reset
        if (currentRow.length === 3 || i === 13) {
            buttons.push(currentRow);
            currentRow = [];
        }
    }

    return buttons;
}

/**
 * Форматувати ім'я користувача
 */
export function formatName(firstName?: string | null, lastName?: string | null, username?: string | null): string {
    if (lastName && firstName) {
        return `${lastName} ${firstName}`;
    }
    if (firstName) {
        return firstName;
    }
    if (username) {
        return `@${username}`;
    }
    return "Unknown";
}

/**
 * Форматувати ПІБ співробітника (Прізвище Ім'я)
 */
export function formatStaffName(fullName: string): string {
    if (!fullName) return "Unknown";
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
        return `${parts[0]} ${parts[1]}`;
    }
    return fullName;
}

/**
 * Скоротити довгий текст
 */
export function truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
}

/**
 * Групувати завдання по локаціях
 */
export function groupTasksByLocation(tasks: any[]) {
    const grouped: Record<string, Record<string, any[]>> = {};

    for (const task of tasks) {
        // Fallback to staff's primary location if task location is missing
        const city = task.city || task.staff?.location?.city || "Other";
        const location = task.locationName || task.staff?.location?.name || "No location";

        if (!grouped[city]) {
            grouped[city] = {};
        }

        if (!grouped[city][location]) {
            grouped[city][location] = [];
        }

        grouped[city][location].push(task);
    }

    return grouped;
}

/**
 * Форматувати дедлайн для відображення
 */
export function formatDeadline(workDate: Date | null, deadlineTime: string | null): string {
    if (!workDate) return "";

    const date = new Date(workDate);
    const displayDate = `${date.getDate().toString().padStart(2, "0")}.${(date.getMonth() + 1).toString().padStart(2, "0")}`;

    if (deadlineTime) {
        return `${displayDate} by ${deadlineTime}`;
    }

    return displayDate;
}
