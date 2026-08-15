import { InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { escapeHtml, formatLocation } from "../handlers/admin/utils.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import {
    awsBusinessClient,
    type AwsScheduleChangeKind,
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

const CHANGE_KIND_TEXT: Record<AwsScheduleChangeKind, string> = {
    SHIFT_ADDED: STAFF_TEXTS["schedule-notif-kind-added"],
    SHIFT_REMOVED: STAFF_TEXTS["schedule-notif-kind-removed"],
    SHIFT_MOVED: STAFF_TEXTS["schedule-notif-kind-moved"],
    SHIFT_REASSIGNED: STAFF_TEXTS["schedule-notif-kind-reassigned"]
};

/**
 * Pure rendering of one delivery group into Telegram HTML.
 */
export function renderDeliveryGroup(group: ScheduleNotificationDeliveryGroup): string {
    const lines: string[] = [
        group.urgency === "URGENT"
            ? STAFF_TEXTS["schedule-notif-urgent-title"]
            : STAFF_TEXTS["schedule-notif-normal-title"],
        ""
    ];

    for (const notification of group.notifications) {
        lines.push(CHANGE_KIND_TEXT[notification.changeKind]);
        const before = describeSnapshot(notification.payload.before);
        const after = describeSnapshot(notification.payload.after);
        if (before) lines.push(STAFF_TEXTS["schedule-notif-line-was"]({ details: escapeHtml(before) }));
        if (after) lines.push(STAFF_TEXTS["schedule-notif-line-now"]({ details: escapeHtml(after) }));
        if (!before && !after) lines.push(STAFF_TEXTS["schedule-notif-details-unknown"]);
        const reason = notification.payload.reason?.trim() ?? "";
        if (reason) lines.push(STAFF_TEXTS["schedule-notif-reason"]({ reason: escapeHtml(reason) }));
        lines.push("");
    }

    if (group.notifications.length > 1) {
        lines.push(STAFF_TEXTS["schedule-notif-summary"]({ count: group.notifications.length }));
    }
    lines.push(STAFF_TEXTS["schedule-notif-footer"]);

    return lines.join("\n");
}

/**
 * Renders one snapshot as `ДД.ММ, HH:MM-HH:MM, Локація (Місто)`.
 *
 * `startsAtLocal` / `endsAtLocal` are already local wall-clock strings for the
 * location's timezone, so they are read as text and never passed through `Date`
 * — constructing a Date here would re-interpret them in the bot's own timezone
 * and shift the time the photographer sees.
 *
 * `locationPublicId` is deliberately never rendered; it is correlation data.
 */
function describeSnapshot(snapshot: AwsScheduleNotificationShiftSnapshot | undefined): string {
    if (!snapshot) return "";

    const day = formatLocalDay(snapshot.startsAtLocal);
    const startTime = formatLocalTime(snapshot.startsAtLocal);
    const endTime = formatLocalTime(snapshot.endsAtLocal);
    const time = startTime && endTime ? `${startTime}-${endTime}` : startTime;

    const place = formatLocation(
        { name: snapshot.locationName, branch: snapshot.locationBranch, city: snapshot.locationCity },
        "listing"
    );

    const parts = [day, time, place].filter(part => part.length > 0);
    return parts.join(", ");
}

/** `2026-08-10T10:00:00` -> `10.08`. Pure string reading, no timezone maths. */
function formatLocalDay(localDateTime: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(localDateTime);
    if (!match) return "";
    return `${match[3]}.${match[2]}`;
}

/** `2026-08-10T10:00:00` -> `10:00`. Pure string reading, no timezone maths. */
function formatLocalTime(localDateTime: string): string {
    const match = /[T ](\d{2}:\d{2})/u.exec(localDateTime);
    return match?.[1] ?? "";
}

/**
 * Signed-callback code for the accepting photographer's own undo button.
 * Exported so the Telegram callback handler in `handlers/index.ts` matches on
 * the exact same string this dispatcher signs with, rather than a second
 * hardcoded copy — mirrors `REPLACEMENT_REVERT_CALLBACK_CODE`.
 */
export const REPLACEMENT_UNDO_CALLBACK_CODE = "replun";

/**
 * The undo button belongs only on the one message that is unambiguously "you
 * just accepted a replacement, moments ago": a group of exactly one
 * SHIFT_REASSIGNED notification, addressed to the accepting candidate, whose
 * payload carries the offer id the undo endpoint needs.
 *
 * Deliberately refuses a batched group (`notifications.length > 1`): a NORMAL
 * SHIFT_REASSIGNED can be batched with unrelated schedule changes before
 * delivery, and attaching an undo button there would let a tap on one bullet
 * point undo a different, unrelated shift assignment. The bot never verifies
 * the undo window itself either — that stays the backend's job — so this is
 * purely about not offering the button where it cannot mean what it says.
 */
function findUndoableAcceptance(
    group: ScheduleNotificationDeliveryGroup
): { offerPublicId: string } | null {
    if (group.notifications.length !== 1) return null;
    const [notification] = group.notifications;
    if (notification!.changeKind !== "SHIFT_REASSIGNED") return null;
    if (notification!.payload.role !== "accepted") return null;
    const offerPublicId = notification!.payload.offerPublicId;
    if (!offerPublicId) return null;
    return { offerPublicId };
}

/**
 * Urgent messages ask for an acknowledgement of the notification only. A reply
 * never cancels or changes a shift — the backend owns the schedule.
 */
export function buildDeliveryKeyboard(group: ScheduleNotificationDeliveryGroup): InlineKeyboard {
    const undoable = findUndoableAcceptance(group);

    if (group.urgency !== "URGENT") {
        const keyboard = new InlineKeyboard().text(STAFF_TEXTS["schedule-notif-btn-schedule"], "staff_hub_nav");
        if (undoable) {
            keyboard
                .row()
                .text(
                    STAFF_TEXTS["staff-replacement-accepted-btn-undo"],
                    buildSignedCallback(REPLACEMENT_UNDO_CALLBACK_CODE, undoable.offerPublicId)
                );
        }
        return keyboard;
    }

    const publicId = group.notificationPublicIds[0]!;
    const keyboard = new InlineKeyboard()
        .text(STAFF_TEXTS["schedule-notif-btn-confirm"], buildSignedCallback("snack", publicId))
        .text(STAFF_TEXTS["schedule-notif-btn-decline"], buildSignedCallback("sndec", publicId));
    if (undoable) {
        keyboard
            .row()
            .text(
                STAFF_TEXTS["staff-replacement-accepted-btn-undo"],
                buildSignedCallback(REPLACEMENT_UNDO_CALLBACK_CODE, undoable.offerPublicId)
            );
    }
    return keyboard;
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

            const groups = groupForDelivery(pending.items);

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
        try {
            await api.sendMessage(Number(group.telegramId), renderDeliveryGroup(group), {
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
