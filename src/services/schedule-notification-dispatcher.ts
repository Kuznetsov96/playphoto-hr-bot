import { InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import {
    awsBusinessClient,
    type AwsScheduleChangeKind,
    type AwsScheduleNotification
} from "./aws-business-client.js";

const LEASE_KEY = "worker:schedule-notification-dispatcher:lease";
const LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 60 * 1000;
const PENDING_LIMIT = 100;
const MAX_FAILURE_REASON_LENGTH = 500;

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
        const reason = typeof notification.payload.reason === "string" ? notification.payload.reason.trim() : "";
        if (reason) lines.push(STAFF_TEXTS["schedule-notif-reason"]({ reason: escapeHtml(reason) }));
        lines.push("");
    }

    if (group.notifications.length > 1) {
        lines.push(STAFF_TEXTS["schedule-notif-summary"]({ count: group.notifications.length }));
    }
    lines.push(STAFF_TEXTS["schedule-notif-footer"]);

    return lines.join("\n");
}

function describeSnapshot(value: unknown): string {
    if (value === null || typeof value !== "object") return "";
    const snapshot = value as Record<string, unknown>;
    const parts = [snapshot.date, snapshot.time, snapshot.location]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .map(part => part.trim());
    return parts.join(", ");
}

/**
 * Urgent messages ask for an acknowledgement of the notification only. A reply
 * never cancels or changes a shift — the backend owns the schedule.
 */
export function buildDeliveryKeyboard(group: ScheduleNotificationDeliveryGroup): InlineKeyboard {
    if (group.urgency !== "URGENT") {
        return new InlineKeyboard().text(STAFF_TEXTS["schedule-notif-btn-schedule"], "staff_hub_nav");
    }

    const publicId = group.notificationPublicIds[0]!;
    return new InlineKeyboard()
        .text(STAFF_TEXTS["schedule-notif-btn-confirm"], buildSignedCallback("snack", publicId))
        .text(STAFF_TEXTS["schedule-notif-btn-decline"], buildSignedCallback("sndec", publicId));
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
            const groups = groupForDelivery(pending);

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
                    pendingCount: pending.length,
                    groupCount: groups.length,
                    skippedWithoutTelegram: pending.filter(item => item.telegramId === null).length
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
