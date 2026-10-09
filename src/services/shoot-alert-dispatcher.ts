import { GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { ADMIN_IDS } from "../config.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { logBusinessEvent } from "../core/log-events.js";
import { awsBusinessClient, type AwsShootAlert } from "./aws-business-client.js";

export interface ShootAlertClient {
    pendingShootAlerts(limit: number): Promise<{ items: AwsShootAlert[]; invalidPublicIds: string[] }>;
    markShootAlertDelivered(publicId: string): Promise<void>;
    markShootAlertFailed(publicId: string, reason: string): Promise<void>;
}

const PENDING_LIMIT = 50;
const NO_ADMIN = "SHOOT_ALERT_NO_ADMIN_CONFIGURED";
const INVALID = "SHOOT_ALERT_PAYLOAD_INVALID";

const HEADERS: Record<AwsShootAlert["kind"], string> = {
    DAILY_DIGEST: "📸 Shoots without a photographer · next 3 days",
    EVE_OF_SHOOT: "⚠️ Shoot tomorrow, still no photographer",
    LATE_CREATED: "📸 New shoot without a photographer",
};

/** `YYYY-MM-DD` → `ДД.ММ` текстом: через Date дата зсунулась би в поясі процесу. */
function day(date: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    return m ? `${m[3]}.${m[2]}` : date;
}

export function renderShootAlert(alert: AwsShootAlert): string {
    const lines = alert.payload.items.map((i) => {
        const when = escapeHtml(i.startsAtLocalTime ? `${day(i.shootOn)} ${i.startsAtLocalTime}` : day(i.shootOn));
        const who = i.childName ? ` · ${escapeHtml(i.childName)}` : "";
        return `• ${when} · ${escapeHtml(i.locationName)}${who}`;
    });
    return [`<b>${HEADERS[alert.kind]}</b>`, "", ...lines].join("\n");
}

function logFailure(event: string, operation: string, kind?: string): void {
    logBusinessEvent({
        event,
        actorType: "system",
        actorRole: "system",
        result: "failure",
        module: "shoot-alert-dispatcher",
        operation,
        ...(kind ? { safeContext: { kind } } : {}),
    });
}

function sendFailureReason(error: unknown): string {
    if (error instanceof GrammyError) return `TG_${error.error_code}`;
    if (error instanceof HttpError) return "HTTP_ERROR";
    return "SEND_FAILED";
}

export function createShootAlertDispatcher(
    api: Pick<Api, "sendMessage">,
    client: ShootAlertClient = awsBusinessClient,
    adminIds: readonly number[] = ADMIN_IDS,
) {
    /** Одна ошибка API при отметке не должна ронять остаток пачки. */
    async function safeMarkFailed(publicId: string, reason: string): Promise<void> {
        try {
            await client.markShootAlertFailed(publicId, reason);
        } catch {
            logFailure("bot.shoot_alerts.mark_failed_failed", "markFailed");
        }
    }

    return {
        async runOnce(): Promise<void> {
            const { items, invalidPublicIds } = await client.pendingShootAlerts(PENDING_LIMIT);
            for (const id of invalidPublicIds) await safeMarkFailed(id, INVALID);
            const target = adminIds[0];
            for (const alert of items) {
                if (target === undefined) {
                    await safeMarkFailed(alert.publicId, NO_ADMIN);
                    continue;
                }
                try {
                    await api.sendMessage(target, renderShootAlert(alert), {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().url("Open", alert.payload.openUrl),
                    });
                } catch (error: unknown) {
                    // Только код ошибки: сырой текст Telegram может нести лишнее.
                    const reason = sendFailureReason(error);
                    await safeMarkFailed(alert.publicId, reason);
                    logFailure("bot.shoot_alerts.send_failed", "runOnce", alert.kind);
                    continue;
                }
                // Telegram уже принял сообщение: сбой отметки не повод помечать failed (будет дубль).
                try {
                    await client.markShootAlertDelivered(alert.publicId);
                } catch {
                    logFailure("bot.shoot_alerts.mark_delivered_failed", "runOnce", alert.kind);
                }
            }
        },
    };
}
