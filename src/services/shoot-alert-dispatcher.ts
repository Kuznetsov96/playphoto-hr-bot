import { InlineKeyboard } from "grammy";
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
    DAILY_DIGEST: "📸 Зйомки без фотографа на найближчі 3 дні",
    EVE_OF_SHOOT: "⚠️ Завтра зйомка, а фотографа досі немає",
    LATE_CREATED: "📸 Нова зйомка без фотографа",
};

/** `YYYY-MM-DD` → `ДД.ММ` текстом: через Date дата зсунулась би в поясі процесу. */
function day(date: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    return m ? `${m[3]}.${m[2]}` : date;
}

export function renderShootAlert(alert: AwsShootAlert): string {
    const lines = alert.payload.items.map((i) => {
        const when = i.startsAtLocalTime ? `${day(i.shootOn)} ${i.startsAtLocalTime}` : day(i.shootOn);
        const who = i.childName ? ` · ${escapeHtml(i.childName)}` : "";
        return `• ${when} · ${escapeHtml(i.locationName)}${who}`;
    });
    return [`<b>${HEADERS[alert.kind]}</b>`, "", ...lines].join("\n");
}

export function createShootAlertDispatcher(
    api: Pick<Api, "sendMessage">,
    client: ShootAlertClient = awsBusinessClient,
    adminIds: readonly number[] = ADMIN_IDS,
) {
    return {
        async runOnce(): Promise<void> {
            const { items, invalidPublicIds } = await client.pendingShootAlerts(PENDING_LIMIT);
            for (const id of invalidPublicIds) await client.markShootAlertFailed(id, INVALID);
            const target = adminIds[0];
            for (const alert of items) {
                if (target === undefined) {
                    await client.markShootAlertFailed(alert.publicId, NO_ADMIN);
                    continue;
                }
                try {
                    await api.sendMessage(target, renderShootAlert(alert), {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().url("Відкрити", alert.payload.openUrl),
                    });
                    await client.markShootAlertDelivered(alert.publicId);
                } catch (error: unknown) {
                    // Только описание ошибки Telegram, без текста сообщения.
                    const reason = error instanceof Error ? error.message.slice(0, 200) : "SEND_FAILED";
                    await client.markShootAlertFailed(alert.publicId, reason);
                    logBusinessEvent({
                        event: "bot.shoot_alerts.send_failed",
                        actorType: "system",
                        actorRole: "system",
                        result: "failure",
                        module: "shoot-alert-dispatcher",
                        operation: "runOnce",
                        safeContext: { kind: alert.kind },
                    });
                }
            }
        },
    };
}
