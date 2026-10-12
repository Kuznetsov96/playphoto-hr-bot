import { InlineKeyboard } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { formatLocation } from "../utils/location-label.js";
import { clip, dayLabel, formatDuration, formatIntervals, formatUah } from "../utils/shoot-format.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { ukDays } from "../utils/uk-plural.js";
import type { AwsShootTask } from "./aws-business-client.js";

export const SHOOT_DUE_PICK_CODE = "sdp";
export const SHOOT_DUE_DATE_CODE = "sdd";
export const SHOOT_DUE_CONFIRM_CODE = "sdc";
export const SHOOT_DUE_BACK_CODE = "sdb";
export const SHOOT_SUPPORT_CODE = "sds";
/** Кнопки пропозиції (частина C): payload — `ref` пропозиції, не рядка outbox. */
export const SHOOT_OFFER_TAKE_CODE = "sha";
export const SHOOT_OFFER_DECLINE_CODE = "shd";
export const SHOOT_OFFER_UNDO_CODE = "shu";

/**
 * Імена коротші за загальні 500 символів — обмеження для читання, не для Telegram: ліміт 4096
 * Telegram рахує після розбору сутностей, тож `&amp;` там лише один символ.
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

/** Хто отримує телефон: призначена — після призначення менеджером чи після «Беру». */
const WITH_PHONE: ReadonlySet<AwsShootTask["kind"]> = new Set(["ASSIGNED", "OFFER_TAKEN"]);

/**
 * Телефон — лише в ASSIGNED і OFFER_TAKEN; REDACT той самий текст, але «телефон приховано.».
 * Моноширинний: Telegram копіює `<code>` одним дотиком. Схема пускає лише E.164 — екранувати нічого.
 */
function clientLine(item: AwsShootTask): string {
    const client = safe(item.shoot.clientName, NAME_LIMIT);
    const phone = WITH_PHONE.has(item.kind) && item.shoot.phone !== null ? `<code>${item.shoot.phone}</code>` : null;
    if (phone !== null) {
        return STAFF_TEXTS["shoot-task-client"]({ client: client === null ? phone : `${client}, ${phone}` });
    }
    const tail = item.kind === "REDACT" ? STAFF_TEXTS["shoot-task-phone-hidden"] : STAFF_TEXTS["shoot-task-no-phone"];
    return STAFF_TEXTS["shoot-task-client"]({ client: client === null ? tail : `${client} · ${tail}` });
}

/** «🕐 15:00–16:00 (1 год)» — однаково в призначенні й у пропозиції; без інтервалів рядка немає. */
function timeLine(item: AwsShootTask): string | null {
    const time = formatIntervals(item.shoot.intervals);
    if (time === "") return null;
    const duration = item.shoot.durationMinutes === null ? "" : ` (${formatDuration(item.shoot.durationMinutes)})`;
    return `🕐 ${time}${duration}`;
}

/** Тіло ASSIGNED без першого рядка: OFFER_TAKEN ставить над ним «✅ Зйомка твоя.». */
function assignedBody(item: AwsShootTask): string {
    const lines = [locationLine(item), `📅 ${dayLabel(item.shoot.shootOn)}`];
    const time = timeLine(item);
    if (time !== null) lines.push(time);
    lines.push(clientLine(item));
    const child = safe(item.shoot.childName, NAME_LIMIT);
    if (child !== null) lines.push(STAFF_TEXTS["shoot-task-child"]({ name: child }));
    const notes = safe(item.shoot.notes);
    if (notes !== null) lines.push(STAFF_TEXTS["shoot-task-notes"]({ notes }));
    lines.push("", STAFF_TEXTS["shoot-task-assigned-due"]({ due: dayLabel(item.dueOn) }));
    return lines.join("\n");
}

function assignedText(item: AwsShootTask): string {
    return `${STAFF_TEXTS["shoot-task-assigned-head"]}\n\n${assignedBody(item)}`;
}

/** Пропозиція йде багатьом: точка, дата, інтервали, тривалість і ставка (якщо є тариф). */
function offerText(item: AwsShootTask, feeAmount: number | null): string {
    const lines = [STAFF_TEXTS["shoot-offer-head"], "", locationLine(item), `📅 ${dayLabel(item.shoot.shootOn)}`];
    const time = timeLine(item);
    if (time !== null) lines.push(time);
    if (feeAmount !== null && feeAmount > 0) lines.push(STAFF_TEXTS["shoot-offer-fee"]({ amount: formatUah(feeAmount) }));
    lines.push("", STAFF_TEXTS["shoot-offer-first-wins"]);
    return lines.join("\n");
}

const offerPlace = (item: AwsShootTask) => ({
    location: escapeHtml(formatLocation(item.shoot.location, "listing")),
    date: dayLabel(item.shoot.shootOn),
});

/** «✅ Беру» і «🚫 Не можу» в один ряд — однакові за вагою відповіді на одне питання. */
export function offerKeyboard(offerRef: string): InlineKeyboard {
    return new InlineKeyboard()
        .text(STAFF_TEXTS["shoot-offer-btn-take"], buildSignedCallback(SHOOT_OFFER_TAKE_CODE, offerRef))
        .text(STAFF_TEXTS["shoot-offer-btn-decline"], buildSignedCallback(SHOOT_OFFER_DECLINE_CODE, offerRef));
}

/** «Скасувати» (ref пропозиції) і підтримка (ref рядка outbox, як у ASSIGNED). */
function takenKeyboard(offerRef: string, taskRef: string): InlineKeyboard {
    return new InlineKeyboard()
        .text(STAFF_TEXTS["shoot-offer-btn-undo"], buildSignedCallback(SHOOT_OFFER_UNDO_CODE, offerRef))
        .row()
        .text(STAFF_TEXTS["staff-preferences-btn-support"], buildSignedCallback(SHOOT_SUPPORT_CODE, taskRef));
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

/**
 * Стан «Готово» після переносу фотографом (спек «Выбор даты»): рядок терміну замінено на
 * «Новий термін — … включно. Нагадаю зранку в цей день.», дата в повідомленні одна, кнопка —
 * лише підтримка. «Термін минув…» і «Сьогодні останній день…» після переносу неправда, тож
 * PHOTOS_DUE, DUE_TODAY і OVERDUE стають «Чекаємо фото зі зйомки.»; RETURNED зберігає «Що виправити».
 */
function renderMoved(item: AwsShootTask): { text: string; keyboard: InlineKeyboard } {
    const block = shootBlock(item);
    const due = dayLabel(item.dueOn);
    if (item.kind === "RETURNED") {
        const comment = safe(item.returnComment) ?? "—";
        return {
            text: withPathB(
                item,
                `${STAFF_TEXTS["shoot-task-returned-head"]}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-returned-what"]}\n<blockquote>${comment}</blockquote>\n\n${STAFF_TEXTS["shoot-task-returned-due-moved"]({ due })}`,
            ),
            keyboard: supportKeyboard(item.ref),
        };
    }
    return {
        text: withPathB(
            item,
            `${STAFF_TEXTS["shoot-task-photos-due-head"]}\n\n${block}\n\n${STAFF_TEXTS["shoot-task-due-moved"]({ due })}\n${STAFF_TEXTS["shoot-task-send-hint"]}`,
        ),
        keyboard: supportKeyboard(item.ref),
    };
}

const MOVABLE_KINDS: ReadonlySet<AwsShootTask["kind"]> = new Set(["PHOTOS_DUE", "DUE_TODAY", "OVERDUE", "RETURNED"]);

/** Текст і кнопки повідомлення — таблиця «Сообщения» спеку, рядок за рядком. */
export function renderShootTask(
    item: AwsShootTask,
    options: { moved?: boolean } = {},
): { text: string; keyboard: InlineKeyboard | null } {
    if (options.moved === true && MOVABLE_KINDS.has(item.kind)) return renderMoved(item);
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
        case "OFFER":
            return { text: offerText(item, item.payload.feeAmount), keyboard: offerKeyboard(item.payload.offerRef) };
        case "OFFER_REOPENED":
            return { text: STAFF_TEXTS["shoot-offer-reopened"](offerPlace(item)), keyboard: offerKeyboard(item.payload.offerRef) };
        case "OFFER_TAKEN":
            return {
                text: `${STAFF_TEXTS["shoot-offer-taken-head"]}\n\n${assignedBody(item)}\n\n${STAFF_TEXTS["shoot-offer-taken-undo-hint"]}`,
                keyboard: takenKeyboard(item.payload.offerRef, item.ref),
            };
        case "OFFER_CLOSED": {
            const key = item.payload.variant === "TAKEN" ? "shoot-offer-closed-taken" : "shoot-offer-closed";
            return { text: STAFF_TEXTS[key](offerPlace(item)), keyboard: null };
        }
    }
}
