import { InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { formatLocation } from "../utils/location-label.js";
import {
    formatMonthSection,
    formatMonthTotal,
    formatNewShiftsList,
    formatShiftLine,
    formatChangeLine,
    updateMark,
    type MonthNote,
    type MonthRow,
    type ShiftChange,
    type ScheduleMessageShift
} from "../utils/format-schedule-message.js";
import { loadMonthContext, shiftKey, type MonthContext } from "./schedule-month-context.js";
import {
    awsBusinessClient,
    type AwsScheduleNotification,
    type AwsScheduleNotificationShiftSnapshot
} from "./aws-business-client.js";

const LEASE_KEY = "worker:schedule-notification-dispatcher:lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const PENDING_LIMIT = 100;
const MAX_FAILURE_REASON_LENGTH = 500;

/**
 * Reported for a row whose payload does not match the agreed contract. A fixed
 * code, deliberately carrying no field names and no values from the payload.
 */
const INVALID_PAYLOAD_REASON = "SCHEDULE_NOTIFICATION_PAYLOAD_INVALID";

/**
 * One Telegram message to one photographer.
 *
 * A published batch collapses into a single group keyed by
 * `(employeePublicId, batchId)`; urgent rows are never batched.
 */
export interface ScheduleNotificationDeliveryGroup {
    employeePublicId: string;
    telegramId: string;
    urgency: AwsScheduleNotification["urgency"];
    notificationPublicIds: string[];
    notifications: AwsScheduleNotification[];
}

/**
 * Pure grouping. The backend already decided urgency, recipients, and dedup —
 * this only decides how many Telegram messages those rows become.
 */
export function groupForDelivery(
    notifications: AwsScheduleNotification[]
): ScheduleNotificationDeliveryGroup[] {
    const groups: ScheduleNotificationDeliveryGroup[] = [];
    const byKey = new Map<string, ScheduleNotificationDeliveryGroup>();

    for (const notification of notifications) {
        // No linked Telegram account means nothing can be delivered at all.
        if (notification.telegramId === null) continue;

        const batchable = notification.urgency === "NORMAL" && notification.batchId !== null;
        if (!batchable) {
            groups.push({
                employeePublicId: notification.employeePublicId,
                telegramId: notification.telegramId,
                urgency: notification.urgency,
                notificationPublicIds: [notification.publicId],
                notifications: [notification]
            });
            continue;
        }

        const key = `${notification.employeePublicId}:${notification.batchId}`;
        const existing = byKey.get(key);
        if (existing) {
            existing.notificationPublicIds.push(notification.publicId);
            existing.notifications.push(notification);
            continue;
        }

        const group: ScheduleNotificationDeliveryGroup = {
            employeePublicId: notification.employeePublicId,
            telegramId: notification.telegramId,
            urgency: notification.urgency,
            notificationPublicIds: [notification.publicId],
            notifications: [notification]
        };
        byKey.set(key, group);
        groups.push(group);
    }

    return groups;
}

/**
 * Pure rendering of one delivery group into Telegram HTML.
 *
 * With the person's current month at hand (`months`), a normal message shows
 * the WHOLE month with what is new marked — the last schedule message always
 * reads as her full month, which is how people read it anyway (incident
 * 12.10.2026). Urgent changes and replacements stay one sentence per event and
 * end with the month total instead of a list.
 *
 * Without the month (the read failed), nothing may claim to be a total: the
 * text names only what changed and points to «Мій графік».
 *
 * Structure follows how a person reads it: what happened (title) → events or
 * the month → total. No request to answer: an urgent change is a fact the
 * owner has already decided, and nobody reads the acknowledgements (owner,
 * 29.08.2026).
 */
export function renderDeliveryGroup(
    group: ScheduleNotificationDeliveryGroup,
    months: MonthContext | null = null
): string {
    const replacementOnly = group.notifications.every(
        notification => isReplacementGiven(notification) || isReplacementTaken(notification)
    );
    if (months !== null && group.urgency === "NORMAL" && !replacementOnly) {
        const sections = renderMonthSections(group, months);
        if (sections !== null) return sections;
    }

    // Без місяця пакет «самих додань» лишається календарем, але без слова
    // «готовий» і без числа, яке читалося б як увесь місяць.
    if (months === null) {
        const added = asAddedList(group);
        if (added !== null) return formatNewShiftsList(added);
    }

    const lines: string[] = [
        group.notifications.every(isReplacementGiven)
            ? STAFF_TEXTS["schedule-notif-replacement-found-title"]
            : group.urgency === "URGENT" && !group.notifications.every(isReplacementTaken)
            ? STAFF_TEXTS["schedule-notif-urgent-title"]
            : STAFF_TEXTS["schedule-notif-normal-title"],
        ""
    ];

    for (const notification of group.notifications) {
        // Причина скасування — внутрішня помітка власника; навіть якщо
        // старий рядок ще несе `reason`, фотографу вона не показується.
        lines.push(...describeChange(notification));
        lines.push("");
    }

    // Підсумок — це завжди кількість змін людини в місяці, ніколи не кількість
    // подій: «Всього змін: 19» під 14 знятими й 5 доданими читалося як 19
    // робочих днів.
    if (months !== null) {
        for (const month of monthsOf(group)) {
            const rows = months.get(month);
            if (rows !== undefined) lines.push(formatMonthTotal(`${month}-01`, rows.length));
        }
    } else if (group.notifications.length > 1) {
        lines.push(STAFF_TEXTS["schedule-notif-see-schedule"]);
    }

    return lines.join("\n").trimEnd();
}

/** `YYYY-MM` of every shift a group touches, before and after, in order. */
export function monthsOf(group: ScheduleNotificationDeliveryGroup): string[] {
    const months = new Set<string>();
    for (const notification of group.notifications) {
        for (const snapshot of [notification.payload.before, notification.payload.after]) {
            const shift = snapshot === undefined ? null : toShift(snapshot);
            if (shift !== null) months.add(shift.localDate.slice(0, 7));
        }
    }
    return [...months].sort();
}

/**
 * One section per touched month: the month's current shifts, with the events
 * of this group marked in it (added, changed) or listed above it (removed,
 * the old date of a changed shift, given away through a replacement).
 *
 * «Готовий» only when this group is the person's whole month — every shift she
 * has in it arrives right now. Shifts written into an already published month
 * read «змінено», even when all of them are additions. Null when an event
 * carries no readable snapshot: then the event text is the honest fallback.
 */
function renderMonthSections(
    group: ScheduleNotificationDeliveryGroup,
    months: MonthContext
): string | null {
    const sections = new Map<string, { rows: MonthRow[]; byKey: Map<string, MonthRow>; notes: MonthNote[] }>();
    const sectionOf = (month: string) => {
        let section = sections.get(month);
        if (section === undefined) {
            const rows: MonthRow[] = (months.get(month) ?? []).map(item => ({
                shift: item.shift,
                locationKey: item.locationKey
            }));
            const byKey = new Map((months.get(month) ?? []).map((item, index) => [item.key, rows[index]!] as const));
            section = { rows, byKey, notes: [] };
            sections.set(month, section);
        }
        return section;
    };
    const mark = (event: KeyedShift, value: NonNullable<MonthRow["mark"]>) => {
        const row = sectionOf(event.month).byKey.get(event.key);
        // Зміни вже немає в тому вигляді (її встигли змінити ще раз) —
        // список місяця і так показує, як є зараз.
        if (row !== undefined) row.mark = value;
    };
    const note = (event: KeyedShift, change: ShiftChange) => {
        sectionOf(event.month).notes.push({ change, localDate: event.shift.localDate, locationKey: event.locationKey });
    };

    for (const notification of group.notifications) {
        const before = keyed(notification.payload.before);
        const after = keyed(notification.payload.after);

        if (isReplacementGiven(notification)) {
            if (before === null) return null;
            note(before, { kind: "given", shift: before.shift });
            continue;
        }

        switch (notification.changeKind) {
            // Переназначення на неї — для неї це нова зміна: попередній вигляд
            // описував би чужу зміну.
            case "SHIFT_ADDED":
            case "SHIFT_REASSIGNED":
                if (after === null) return null;
                sectionOf(after.month);
                mark(after, "added");
                break;
            case "SHIFT_MOVED":
                if (after === null && before === null) return null;
                if (after === null) {
                    note(before!, { kind: "removed", shift: before!.shift });
                    break;
                }
                sectionOf(after.month);
                mark(after, before === null ? "updated" : updateMark(before.shift, after.shift));
                if (before !== null && (before.key !== after.key || !sameShift(before, after))) {
                    note(after, { kind: "updated", from: before.shift, to: after.shift });
                }
                break;
            case "SHIFT_REMOVED":
                if (before === null) return null;
                note(before, { kind: "removed", shift: before.shift });
                break;
        }
    }

    const everythingAdded = group.notifications.every(notification => notification.changeKind === "SHIFT_ADDED");
    return [...sections.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([month, section]) => formatMonthSection({
            mode: everythingAdded
                && section.notes.length === 0
                && section.rows.length > 0
                && section.rows.every(row => row.mark === "added")
                ? "published"
                : "updated",
            monthDate: `${month}-01`,
            rows: section.rows,
            notes: section.notes
        }))
        .join("\n\n");
}

type KeyedShift = { month: string; key: string; locationKey: string; shift: ScheduleMessageShift };

function keyed(snapshot: AwsScheduleNotificationShiftSnapshot | undefined): KeyedShift | null {
    if (snapshot === undefined) return null;
    const shift = toShift(snapshot);
    if (shift === null) return null;
    return {
        month: shift.localDate.slice(0, 7),
        key: shiftKey(snapshot.locationPublicId, shift.localDate, shift.startsAtLocal),
        locationKey: snapshot.locationPublicId,
        shift
    };
}

function sameShift(left: KeyedShift, right: KeyedShift): boolean {
    return left.shift.startsAtLocal === right.shift.startsAtLocal && left.shift.endsAtLocal === right.shift.endsAtLocal;
}

/**
 * The requester's copy of a confirmed replacement. The backend records it as
 * SHIFT_REMOVED (older rows as SHIFT_REASSIGNED); either way it is the shift
 * she asked to give away, and it has to read as a found replacement — not as
 * an urgent removal.
 */
function isReplacementGiven(notification: AwsScheduleNotification): boolean {
    return notification.payload.role === "requester"
        && notification.payload.before !== undefined
        && (notification.changeKind === "SHIFT_REMOVED" || notification.changeKind === "SHIFT_REASSIGNED");
}

/**
 * The accepting photographer's copy of a replacement. It answers a tap she has
 * just made, and since 09.10.2026 the backend sends it at once (URGENT) so the
 * undo button arrives while the window is open — the urgent title would read
 * as an alarm about a shift she chose herself.
 */
function isReplacementTaken(notification: AwsScheduleNotification): boolean {
    return notification.payload.role === "accepted" && notification.changeKind === "SHIFT_REASSIGNED";
}

/**
 * One event as the reader experiences it. A single-sided event is one
 * sentence with the shift line; only a real before→after gets two lines.
 * Replacements name the person's role — the backend already knows it.
 */
function describeChange(notification: AwsScheduleNotification): string[] {
    const before = notification.payload.before === undefined ? null : toShift(notification.payload.before);
    const after = notification.payload.after === undefined ? null : toShift(notification.payload.after);

    if (isReplacementGiven(notification) && before) {
        return [STAFF_TEXTS["schedule-notif-replacement-given"]({
            shift: formatShiftLine(before),
            name: notification.payload.counterpartDisplayName
                ? escapeHtml(notification.payload.counterpartDisplayName)
                : undefined
        })];
    }

    switch (notification.changeKind) {
        case "SHIFT_ADDED":
            return after
                ? [formatChangeLine({ kind: "added", shift: after })]
                : [STAFF_TEXTS["schedule-notif-added-unknown"]];
        case "SHIFT_REMOVED":
            return before
                ? [formatChangeLine({ kind: "removed", shift: before })]
                : [STAFF_TEXTS["schedule-notif-removed-unknown"]];
        case "SHIFT_MOVED":
            if (after) return [formatChangeLine({ kind: "updated", ...(before ? { from: before } : {}), to: after })];
            return before
                ? [formatChangeLine({ kind: "removed", shift: before })]
                : [STAFF_TEXTS["schedule-notif-updated-unknown"]];
        // Переназначення на неї — для неї це нова зміна: «було» описувало б
        // чужу зміну.
        case "SHIFT_REASSIGNED":
            if (after) {
                return [formatChangeLine({ kind: notification.payload.role === "accepted" ? "taken" : "added", shift: after })];
            }
            return [STAFF_TEXTS["schedule-notif-added-unknown"]];
    }
}

/**
 * A batched group made only of added shifts with snapshots — a published month
 * or shifts written into one. Anything else (single change, removals, moves, a
 * row without a snapshot) renders as a change log.
 */
function asAddedList(group: ScheduleNotificationDeliveryGroup): ScheduleMessageShift[] | null {
    if (group.urgency !== "NORMAL" || group.notifications.length < 2) return null;
    const shifts: ScheduleMessageShift[] = [];
    for (const notification of group.notifications) {
        const after = notification.payload.after;
        if (notification.changeKind !== "SHIFT_ADDED" || after === undefined) return null;
        const shift = toShift(after);
        if (shift === null) return null;
        shifts.push(shift);
    }
    return shifts;
}

/**
 * Snapshot → shift line input. `startsAtLocal` / `endsAtLocal` are already
 * local wall-clock strings for the location's timezone, so they are read as
 * text and never passed through `Date` — constructing a Date here would
 * re-interpret them in the bot's own timezone and shift what the photographer
 * sees. `locationPublicId` is deliberately never rendered; it is correlation
 * data. Null when the date cannot be read at all.
 */
function toShift(snapshot: AwsScheduleNotificationShiftSnapshot): ScheduleMessageShift | null {
    const localDate = /^(\d{4}-\d{2}-\d{2})/u.exec(snapshot.startsAtLocal)?.[1];
    if (localDate === undefined) return null;
    return {
        localDate,
        locationLabel: formatLocation(
            { name: snapshot.locationName, branch: snapshot.locationBranch, city: snapshot.locationCity },
            "listing"
        ),
        startsAtLocal: formatLocalTime(snapshot.startsAtLocal),
        endsAtLocal: formatLocalTime(snapshot.endsAtLocal)
    };
}

/** `2026-08-10T10:00:00` -> `10:00`. Pure string reading, no timezone maths. */
function formatLocalTime(localDateTime: string): string {
    const match = /[T ](\d{2}:\d{2})/u.exec(localDateTime);
    return match?.[1] ?? "";
}

/**
 * Signed-callback code for the accepting photographer's own undo button. The
 * button lives on the answered offer card (handlers/replacement-callbacks.ts);
 * the code stays here so messages already sitting in chats keep matching.
 */
export const REPLACEMENT_UNDO_CALLBACK_CODE = "replun";

/**
 * The accepting photographer's own echo of a replacement she just took by
 * tapping «Можу» on the offer card. The card is already rewritten to
 * «✅ Ти виходиш на цю зміну» and carries the undo button
 * (handlers/replacement-callbacks.ts), so a separate «Зміну передано тобі»
 * would say the same thing a second time (owner, 09.10.2026). Only the
 * auto-confirm path carries `offerPublicId`; an owner's later approval has
 * none and is real news, so it is still sent.
 */
export function isAcceptanceEcho(notification: AwsScheduleNotification): boolean {
    return notification.changeKind === "SHIFT_REASSIGNED"
        && notification.payload.role === "accepted"
        && Boolean(notification.payload.offerPublicId);
}

/**
 * One keyboard for every schedule message: "My schedule". The undo button
 * moved to the offer card itself (09.10.2026). Urgent messages differ only by
 * title — the acknowledgement buttons were removed on 29.08.2026 because
 * nobody reads the answers; the `snack`/`sndec` handlers stay for messages
 * already sitting in chats.
 */
export function buildDeliveryKeyboard(_group: ScheduleNotificationDeliveryGroup): InlineKeyboard {
    return new InlineKeyboard().text(STAFF_TEXTS["schedule-notif-btn-schedule"], "staff_hub_nav");
}

/**
 * Maps any delivery error onto a short, non-PII reason code for the backend.
 * Never carries a phone number, a name, or a raw payload.
 */
export function toSafeFailureReason(error: unknown): string {
    const description = error instanceof Error ? error.message : "";
    if (/blocked|deactivated|user is deactivated|bot was blocked/iu.test(description)) {
        return "TELEGRAM_RECIPIENT_UNREACHABLE";
    }
    if (/chat not found|user not found/iu.test(description)) {
        return "TELEGRAM_CHAT_NOT_FOUND";
    }
    if (/too many requests|429|flood/iu.test(description)) {
        return "TELEGRAM_RATE_LIMITED";
    }
    if (/timeout|aborted/iu.test(description)) {
        return "TELEGRAM_DELIVERY_TIMEOUT";
    }
    return "TELEGRAM_DELIVERY_FAILED";
}

export class ScheduleNotificationDispatcher {
    private iterationInProgress = false;

    /**
     * One dispatch pass. Guarded by a Redis lease so that only one bot instance
     * can send, and by a local flag so a slow pass never overlaps itself.
     */
    async runOnce(api: Pick<Api, "sendMessage">): Promise<void> {
        if (this.iterationInProgress) {
            logBusinessEvent({
                event: "bot.schedule_notifications.iteration_skipped",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "skipped",
                reasonCode: "LOCAL_ITERATION_IN_PROGRESS",
                module: "schedule-notification-dispatcher",
                operation: "runOnce"
            });
            return;
        }

        this.iterationInProgress = true;
        const leaseToken = `${process.pid}:${Date.now()}:${Math.random()}`;
        let heartbeat: NodeJS.Timeout | undefined;
        try {
            const acquired = await redis.set(LEASE_KEY, leaseToken, "PX", LEASE_TTL_MS, "NX");
            if (acquired !== "OK") {
                logBusinessEvent({
                    event: "bot.schedule_notifications.iteration_skipped",
                    level: "debug",
                    actorType: "system",
                    actorRole: "system",
                    result: "skipped",
                    reasonCode: "LEASE_HELD_BY_ANOTHER_INSTANCE",
                    module: "schedule-notification-dispatcher",
                    operation: "runOnce"
                });
                return;
            }

            heartbeat = setInterval(() => {
                redis.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
                    1,
                    LEASE_KEY,
                    leaseToken,
                    String(LEASE_TTL_MS)
                ).catch(error => logBusinessEvent({
                    event: "bot.schedule_notifications.lease_renew_failed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    module: "schedule-notification-dispatcher",
                    operation: "renewLease",
                    error
                }));
            }, LEASE_HEARTBEAT_MS);

            const pending = await awsBusinessClient.pendingScheduleNotifications(PENDING_LIMIT);

            // Rows that failed validation are retired individually before any
            // delivery, so one malformed payload costs exactly one notification
            // instead of the whole pass.
            await this.reportInvalid(pending.invalidPublicIds, pending.unidentifiableCount);

            // The echo of her own tap is already on the offer card — it counts as
            // delivered without a second message.
            const echoes = pending.items.filter(isAcceptanceEcho);
            await this.report(echoes.map(item => item.publicId), publicId =>
                awsBusinessClient.markScheduleNotificationDelivered(publicId)
            );
            const groups = groupForDelivery(pending.items.filter(item => !isAcceptanceEcho(item)));

            for (const group of groups) {
                await this.deliverGroup(api, group);
            }

            logBusinessEvent({
                event: "bot.schedule_notifications.iteration_completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "schedule-notification-dispatcher",
                operation: "runOnce",
                safeContext: {
                    pendingCount: pending.items.length,
                    groupCount: groups.length,
                    invalidCount: pending.invalidPublicIds.length,
                    unidentifiableCount: pending.unidentifiableCount,
                    skippedWithoutTelegram: pending.items.filter(item => item.telegramId === null).length
                }
            });
        } catch (error) {
            logBusinessEvent({
                event: "bot.schedule_notifications.iteration_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "PENDING_FETCH_FAILED",
                module: "schedule-notification-dispatcher",
                operation: "runOnce",
                error
            });
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            await redis.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                LEASE_KEY,
                leaseToken
            ).catch(error => logBusinessEvent({
                event: "bot.schedule_notifications.lease_release_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "schedule-notification-dispatcher",
                operation: "releaseLease",
                error
            }));
            this.iterationInProgress = false;
        }
    }

    /**
     * Retires rows the payload schema rejected.
     *
     * The reason is a fixed code, never the Zod issue text: validation messages
     * quote the offending values, which is exactly the payload data that must
     * not leave the bot.
     */
    private async reportInvalid(publicIds: string[], unidentifiableCount: number): Promise<void> {
        if (publicIds.length === 0 && unidentifiableCount === 0) return;

        logBusinessEvent({
            event: "bot.schedule_notifications.invalid_payload",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: INVALID_PAYLOAD_REASON,
            module: "schedule-notification-dispatcher",
            operation: "reportInvalid",
            safeContext: {
                invalidCount: publicIds.length,
                // Rows without a usable publicId cannot be reported at all; they
                // are surfaced here so the backend contract drift is still visible.
                unidentifiableCount
            }
        });

        await this.report(publicIds, publicId =>
            awsBusinessClient.markScheduleNotificationFailed(publicId, INVALID_PAYLOAD_REASON)
        );
    }

    private async deliverGroup(
        api: Pick<Api, "sendMessage">,
        group: ScheduleNotificationDeliveryGroup
    ): Promise<void> {
        // Новенька має спершу прочитати «Вітаємо в команді», а вже потім графік.
        // Збій привітання не зупиняє доставку графіка.
        try {
            const { staffService } = await import("../modules/staff/services/index.js");
            await staffService.welcomeBeforeScheduleMessage(group.telegramId, api);
        } catch (error) {
            logBusinessEvent({
                event: "bot.schedule_notifications.welcome_failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                telegramId: group.telegramId,
                result: "failed",
                module: "schedule-notification-dispatcher",
                operation: "deliverGroup",
                error
            });
        }

        // Увесь місяць людини на зараз — з того ж джерела, що «Мій графік».
        // Збій читання не зупиняє доставку: текст тоді називає лише події.
        let months: MonthContext | null = null;
        try {
            months = await loadMonthContext(group.employeePublicId, monthsOf(group));
        } catch (error) {
            logBusinessEvent({
                event: "bot.schedule_notifications.month_read_failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                telegramId: group.telegramId,
                result: "failed",
                module: "schedule-notification-dispatcher",
                operation: "deliverGroup",
                safeContext: { employeePublicId: group.employeePublicId },
                error
            });
        }

        try {
            await api.sendMessage(Number(group.telegramId), renderDeliveryGroup(group, months), {
                parse_mode: "HTML",
                reply_markup: buildDeliveryKeyboard(group)
            });
        } catch (error) {
            const reason = toSafeFailureReason(error);
            logBusinessEvent({
                event: "bot.schedule_notifications.delivery_failed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                telegramId: group.telegramId,
                result: "failed",
                reasonCode: reason,
                module: "schedule-notification-dispatcher",
                operation: "deliverGroup",
                safeContext: {
                    employeePublicId: group.employeePublicId,
                    urgency: group.urgency,
                    notificationCount: group.notificationPublicIds.length
                },
                error
            });
            await this.report(group.notificationPublicIds, publicId =>
                awsBusinessClient.markScheduleNotificationFailed(
                    publicId,
                    reason.slice(0, MAX_FAILURE_REASON_LENGTH)
                )
            );
            return;
        }

        logBusinessEvent({
            event: "bot.schedule_notifications.delivered",
            actorType: "system",
            actorRole: "system",
            telegramId: group.telegramId,
            result: "success",
            module: "schedule-notification-dispatcher",
            operation: "deliverGroup",
            safeContext: {
                employeePublicId: group.employeePublicId,
                urgency: group.urgency,
                notificationCount: group.notificationPublicIds.length
            }
        });
        await this.report(group.notificationPublicIds, publicId =>
            awsBusinessClient.markScheduleNotificationDelivered(publicId)
        );
    }

    /**
     * Reporting must never abort the pass: a lost receipt only means the
     * backend re-offers the row later, which its own dedup handles.
     */
    private async report(
        publicIds: string[],
        report: (publicId: string) => Promise<void>
    ): Promise<void> {
        for (const publicId of publicIds) {
            try {
                await report(publicId);
            } catch (error) {
                logBusinessEvent({
                    event: "bot.schedule_notifications.report_failed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    reasonCode: "REPORT_REQUEST_FAILED",
                    module: "schedule-notification-dispatcher",
                    operation: "report",
                    error
                });
            }
        }
    }
}

export const scheduleNotificationDispatcher = new ScheduleNotificationDispatcher();
