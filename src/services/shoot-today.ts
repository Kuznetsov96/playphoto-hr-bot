import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { formatLocation } from "../utils/location-label.js";
import { formatIntervals } from "../utils/shoot-format.js";
import { awsBusinessClient, type AwsShootToday } from "./aws-business-client.js";

/** Сьогоднішні зйомки за telegramId фотографа, у порядку початку (так їх віддає вебапп). */
export type ShootsToday = ReadonlyMap<string, readonly AwsShootToday[]>;

const EMPTY: ShootsToday = new Map();

/**
 * Зйомки на `today` (YYYY-MM-DD за Києвом). Вебапп недоступний — порожньо: рядок про зйомку
 * — доповнення, через нього ранкове нагадування про зміну не має зникнути. Інший день у
 * відповіді (опівнічна межа між двома годинниками) — теж порожньо: «сьогодні» про чужий день
 * гірше за мовчання.
 */
export async function readShootsToday(today: string): Promise<ShootsToday> {
    try {
        const { date, items, invalidCount } = await awsBusinessClient.shootsToday();
        if (invalidCount > 0 || date !== today) {
            logBusinessEvent({
                event: "staff.shoots_today.read",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: date === today ? "partial" : "skipped",
                reasonCode: date === today ? "SHOOT_TODAY_ROW_INVALID" : "SHOOT_TODAY_DATE_MISMATCH",
                module: "shoot-today",
                operation: "read",
                safeContext: { invalidCount, date, today },
            });
            if (date !== today) return EMPTY;
        }
        const byTelegramId = new Map<string, AwsShootToday[]>();
        for (const item of items) {
            const list = byTelegramId.get(item.telegramId) ?? [];
            list.push(item);
            byTelegramId.set(item.telegramId, list);
        }
        return byTelegramId;
    } catch (error) {
        logBusinessEvent({
            event: "staff.shoots_today.read",
            level: "warn",
            actorType: "system",
            actorRole: "system",
            result: "fallback",
            reasonCode: "SHOOT_TODAY_UNAVAILABLE",
            module: "shoot-today",
            operation: "read",
            error,
        });
        return EMPTY;
    }
}

/**
 * «🎂 19:00–20:00 — зйомка ДН». Точка — окремим рядком, лише коли вона не та, де фотограф
 * сьогодні на зміні: `shiftLocationAwsId` null/undefined (зміни немає або точка без звʼязку з
 * вебаппом) — точку показано завжди.
 */
export function shootTodayLines(shoots: readonly AwsShootToday[], shiftLocationAwsId?: string | null): string {
    return shoots
        .map((shoot) => {
            const time = formatIntervals(shoot.intervals);
            const line = time === "" ? STAFF_TEXTS["shoot-today-line-no-time"] : STAFF_TEXTS["shoot-today-line"]({ time });
            if (shiftLocationAwsId != null && shiftLocationAwsId === shoot.location.publicId) return line;
            return `${line}\n📍 ${escapeHtml(formatLocation(shoot.location, "listing"))}`;
        })
        .join("\n");
}

/** Окреме ранкове повідомлення тій, у кого сьогодні зйомка, а зміни немає. */
export function shootOnlyMorningText(shoots: readonly AwsShootToday[]): string {
    const name = shoots[0]?.firstName.trim() || "фотографине";
    return `${STAFF_TEXTS["shoot-today-greeting"]({ name: escapeHtml(name) })}\n\n${shootTodayLines(shoots)}`;
}
