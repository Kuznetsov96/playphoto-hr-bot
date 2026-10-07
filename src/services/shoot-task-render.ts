import { InlineKeyboard } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { formatLocation } from "../utils/location-label.js";
import { clip, dayLabel, formatDuration, formatIntervals } from "../utils/shoot-format.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { ukDays } from "../utils/uk-plural.js";
import type { AwsShootTask } from "./aws-business-client.js";

export const SHOOT_DUE_PICK_CODE = "sdp";
export const SHOOT_DUE_DATE_CODE = "sdd";
export const SHOOT_DUE_CONFIRM_CODE = "sdc";
export const SHOOT_DUE_BACK_CODE = "sdb";
export const SHOOT_SUPPORT_CODE = "sds";

/**
 * Імена коротші за загальні 500 символів: після escapeHtml (`&` → `&amp;`) три вільні поля
 * ASSIGNED інакше могли б перерости ліміт Telegram у 4096 символів.
 */
const NAME_LIMIT = 120;

/** Вільний текст: спершу clip, потім escapeHtml — ножиці не влучають усередину `&amp;`. */
const safe = (text: string | null, max?: number): string | null =>
    text === null || text.trim() === "" ? null : escapeHtml(clip(text.trim(), max));

const locationLine = (item: AwsShootTask): string => `📍 ${escapeHtml(formatLocation(item.shoot.location, "listing"))}`;

/** Три рядки, за якими фотограф впізнає зйомку і в касі. */
export function shootBlock(item: AwsShootTask): string {
    const client = safe(item.shoot.clientName, NAME_LIMIT);
    const title = client === null ? STAFF_TEXTS["shoot-task-block-title"] : `${STAFF_TEXTS["shoot-task-block-title"]} · ${client}`;
    const time = formatIntervals(item.shoot.intervals);
    const day = dayLabel(item.shoot.shootOn);
    return [title, locationLine(item), `📅 ${time === "" ? day : `${day}, ${time}`}`].join("\n");
}

/** Телефон — лише в ASSIGNED; REDACT той самий текст, але «телефон приховано.». */
function clientLine(item: AwsShootTask): string {
    const client = safe(item.shoot.clientName, NAME_LIMIT);
    const phone = item.kind === "ASSIGNED" ? item.shoot.phone : null;
    if (phone !== null) {
        return STAFF_TEXTS["shoot-task-client"]({ client: client === null ? phone : `${client}, ${phone}` });
    }
    const tail = item.kind === "REDACT" ? STAFF_TEXTS["shoot-task-phone-hidden"] : STAFF_TEXTS["shoot-task-no-phone"];
    return STAFF_TEXTS["shoot-task-client"]({ client: client === null ? tail : `${client} · ${tail}` });
}

function assignedText(item: AwsShootTask): string {
    const lines = [STAFF_TEXTS["shoot-task-assigned-head"], "", locationLine(item), `📅 ${dayLabel(item.shoot.shootOn)}`];
    const time = formatIntervals(item.shoot.intervals);
    if (time !== "") {
        const duration = item.shoot.durationMinutes === null ? "" : ` (${formatDuration(item.shoot.durationMinutes)})`;
        lines.push(`🕐 ${time}${duration}`);
    }
    lines.push(clientLine(item));
    const child = safe(item.shoot.childName, NAME_LIMIT);
    if (child !== null) lines.push(STAFF_TEXTS["shoot-task-child"]({ name: child }));
    const notes = safe(item.shoot.notes);
    if (notes !== null) lines.push(STAFF_TEXTS["shoot-task-notes"]({ notes }));
    lines.push("", STAFF_TEXTS["shoot-task-assigned-due"]({ due: dayLabel(item.dueOn) }));
    return lines.join("\n");
}

function withPathB(item: AwsShootTask, text: string): string {
    return item.pathB ? `${text}\n${STAFF_TEXTS["shoot-task-path-b"]}` : text;
}

/** Підпис кнопки — той самий, що в пожеланнях («Написати в підтримку»): одна кнопка, одна назва. */
export function supportKeyboard(ref: string): InlineKeyboard {
    return new InlineKeyboard().text(STAFF_TEXTS["staff-preferences-btn-support"], buildSignedCallback(SHOOT_SUPPORT_CODE, ref));
}

function reminderKeyboard(item: AwsShootTask): InlineKeyboard {
    if (!item.canMoveDue) return supportKeyboard(item.ref);
    return new InlineKeyboard()
        .text(STAFF_TEXTS["shoot-task-btn-move"], buildSignedCallback(SHOOT_DUE_PICK_CODE, item.ref))
        .row()
        .text(STAFF_TEXTS["staff-preferences-btn-support"], buildSignedCallback(SHOOT_SUPPORT_CODE, item.ref));
}

/** Текст і кнопки повідомлення — таблиця «Сообщения» спеку, рядок за рядком. */
export function renderShootTask(item: AwsShootTask): { text: string; keyboard: InlineKeyboard | null } {
    const block = shootBlock(item);
    const due = dayLabel(item.dueOn);
    switch (item.kind) {
        case "ASSIGNED":
            return { text: assignedText(item), keyboard: supportKeyboard(item.ref) };
        case "REDACT":
            return { text: assignedText(item), keyboard: null };
        case "PHOTOS_DUE":
            return {
                text: withPathB(
                    item,
                    `${STAFF_TEXTS["shoot-task-photos-due-head"]}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-term"]({ due })}\n${STAFF_TEXTS["shoot-task-send-hint"]}`,
                ),
                keyboard: reminderKeyboard(item),
            };
        case "DUE_TODAY":
            return {
                text: withPathB(item, `${STAFF_TEXTS["shoot-task-due-today-head"]}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-send-hint"]}`),
                keyboard: reminderKeyboard(item),
            };
        case "OVERDUE": {
            const next = item.canMoveDue ? STAFF_TEXTS["shoot-task-overdue-can-move"] : STAFF_TEXTS["shoot-task-overdue-no-move"];
            return {
                text: withPathB(item, `${STAFF_TEXTS["shoot-task-overdue-head"]({ days: ukDays(item.overdueDays ?? 1) })}\n\n${block}\n\n${next}`),
                keyboard: reminderKeyboard(item),
            };
        }
        case "RETURNED": {
            const comment = safe(item.returnComment) ?? "—";
            return {
                text: withPathB(
                    item,
                    `${STAFF_TEXTS["shoot-task-returned-head"]}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-returned-what"]}\n<blockquote>${comment}</blockquote>\n\n${STAFF_TEXTS["shoot-task-returned-due"]({ due })}`,
                ),
                keyboard: reminderKeyboard(item),
            };
        }
        case "DUE_CHANGED":
            return {
                text: `${STAFF_TEXTS["shoot-task-due-changed-head"]({ due })}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-remind-that-day"]}`,
                keyboard: supportKeyboard(item.ref),
            };
        case "UNASSIGNED":
            return { text: `${STAFF_TEXTS["shoot-task-unassigned"]}\n\n${block}`, keyboard: null };
        case "CANCELLED":
            return { text: `${STAFF_TEXTS["shoot-task-cancelled"]}\n\n${block}`, keyboard: null };
    }
}
