import { Bot, InlineKeyboard } from "grammy";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { BOT_TOKEN, TEAM_CHATS } from "../config.js";
import { LOGISTICS_TEXTS_ADMIN, LOGISTICS_TEXTS_STAFF } from "../constants/logistics-constants.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { formatLogisticsLocation, formatLogisticsPhotographerName } from "../utils/logistics-formatters.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import {
    PARCEL_OVERDUE_MS,
    decideDeliveredParcelAction,
    formatSupportDateAgo,
    kyivShiftDateRange,
    selectOverdueAlert,
} from "./parcel-followup-rules.js";

const bot = new Bot(BOT_TOKEN);

const responsibleStaffInclude = {
    responsibleStaff: { include: { user: { select: { firstName: true, lastName: true, username: true } } } },
} as const;

/**
 * Посилка на точці без фото: кому вона належить і коли про неї має дізнатися
 * підтримка. Окремо від LogisticsService, бо той уже тримає синхронізацію з
 * НП і вебаппом; тут лише розмова про посилку, яка вже приїхала.
 */
export class ParcelFollowupService {
    /** Крок циклу: усі DELIVERED без фото й без відповідальної. */
    async assignDeliveredParcels(now = new Date()) {
        const parcels = await prisma.parcel.findMany({
            where: {
                status: "DELIVERED",
                contentPhotoIds: { isEmpty: true },
                responsibleStaffId: null,
                locationId: { not: null },
            },
            select: { id: true },
        });
        for (const parcel of parcels) {
            try {
                await this.followUpDeliveredParcel(parcel.id, now);
            } catch (err) {
                logger.error({ err, parcelId: parcel.id }, "Logistics delivered parcel follow-up failed");
            }
        }
    }

    /**
     * Одна посилка. Публічний, бо в мить переходу в DELIVERED синк кличе саме
     * його замість загального повідомлення зміні — інакше людина отримала б два
     * листи про ту саму коробку за секунду.
     */
    async followUpDeliveredParcel(parcelId: string, now = new Date()) {
        const parcel = await prisma.parcel.findUnique({ where: { id: parcelId }, include: { location: true } });
        if (!parcel?.locationId) return;

        const staff = parcel.deliveryType === "Address" ? await this.staffOnShift(parcel.locationId, now) : [];
        const action = decideDeliveredParcelAction(
            { ...parcel, contentPhotoCount: parcel.contentPhotoIds.length },
            staff.length,
            now,
        );
        const loc = escapeHtml(formatLogisticsLocation(parcel.location));

        if (action.kind === "assign") {
            const only = staff[0]!;
            // Умова в самому UPDATE: між читанням і записом фотографиня могла
            // вже натиснути «Сфотографувати вміст» зі списку посилок.
            const claimed = await prisma.parcel.updateMany({
                where: { id: parcel.id, status: "DELIVERED", responsibleStaffId: null, contentPhotoIds: { isEmpty: true } },
                data: { responsibleStaffId: only.staffId, acceptedAt: now, photoReminderSentAt: null, shiftEndReminderSentAt: null },
            });
            if (claimed.count === 0) return;
            await this.sendToStaff(only.telegramId, LOGISTICS_TEXTS_STAFF.courier_assigned(parcel.ttn, loc), parcel.id);
            this.logEvent("logistics.parcel.courier_assigned", "followUpDeliveredParcel", { parcelId: parcel.id, staffId: only.staffId });
            return;
        }

        if (action.kind === "prompt_claim") {
            let delivered = 0;
            for (const person of staff) {
                if (await this.sendToStaff(person.telegramId, LOGISTICS_TEXTS_STAFF.courier_claim_prompt(parcel.ttn, loc), parcel.id)) {
                    delivered++;
                }
            }
            if (delivered > 0) {
                await prisma.parcel.update({ where: { id: parcel.id }, data: { claimPromptedAt: now } });
            }
            this.logEvent("logistics.parcel.courier_claim_prompted", "followUpDeliveredParcel", {
                parcelId: parcel.id, staffCount: staff.length, delivered,
            });
            return;
        }

        if (action.kind === "alert_outside_pickup") {
            const text = LOGISTICS_TEXTS_ADMIN.outside_pickup_alert({
                ttn: parcel.ttn,
                loc,
                deliveredOn: formatSupportDateAgo(parcel.deliveredAt ?? now, now),
            });
            if (await this.sendToSupport(text, this.manageKeyboard(parcel.id), parcel.id)) {
                await prisma.parcel.update({ where: { id: parcel.id }, data: { outsidePickupAlertSentAt: now } });
                this.logEvent("logistics.parcel.outside_pickup_alert_sent", "followUpDeliveredParcel", { parcelId: parcel.id });
            }
        }
    }

    /**
     * Крок циклу: однократні сигнали підтримці про посилки, що 3 дні чекають
     * фото (DELIVERED) або підтвердження фото (VERIFYING). Колишній «Parcel
     * Delayed … waiting for too long» нічого не пояснював, і на нього не
     * реагували; VERIFYING не мав сигналу взагалі.
     */
    async alertOverdueParcels(now = new Date()) {
        const threshold = new Date(now.getTime() - PARCEL_OVERDUE_MS);
        const parcels = await prisma.parcel.findMany({
            where: {
                OR: [
                    { status: "DELIVERED", contentPhotoIds: { isEmpty: true }, photoOverdueAlertSentAt: null, deliveredAt: { lt: threshold } },
                    { status: "VERIFYING", reviewOverdueAlertSentAt: null, verifyingSince: { lt: threshold } },
                ],
            },
            include: { location: true, ...responsibleStaffInclude },
        });

        for (const parcel of parcels) {
            const kind = selectOverdueAlert({ ...parcel, contentPhotoCount: parcel.contentPhotoIds.length }, now);
            if (!kind) continue;
            const loc = escapeHtml(formatLogisticsLocation(parcel.location));
            const name = parcel.responsibleStaff ? formatLogisticsPhotographerName(parcel.responsibleStaff) : null;

            if (kind === "PHOTO_OVERDUE") {
                const text = LOGISTICS_TEXTS_ADMIN.photo_overdue_alert({
                    ttn: parcel.ttn, loc, responsible: name,
                    delivered: formatSupportDateAgo(parcel.deliveredAt!, now),
                });
                if (await this.sendToSupport(text, this.manageKeyboard(parcel.id), parcel.id)) {
                    await prisma.parcel.update({ where: { id: parcel.id }, data: { photoOverdueAlertSentAt: now } });
                    this.logEvent("logistics.parcel.photo_overdue_alert_sent", "alertOverdueParcels", { parcelId: parcel.id });
                }
                continue;
            }

            const text = LOGISTICS_TEXTS_ADMIN.review_overdue_alert({
                ttn: parcel.ttn, loc, submittedBy: name ?? "Unknown",
                submitted: formatSupportDateAgo(parcel.verifyingSince!, now),
            });
            // apc_ — той самий колбек, що й під альбомом фото: підтвердження
            // звідси нічим не відрізняється від підтвердження там.
            const kb = new InlineKeyboard()
                .text(LOGISTICS_TEXTS_ADMIN.btn_verify, `apc_${parcel.id}`)
                .text(LOGISTICS_TEXTS_ADMIN.btn_view_photo, `admin_parcel_view_${parcel.id}`).row()
                .text("⚙️ Manage Parcel", `admin_parcel_view_details_${parcel.id}`);
            if (await this.sendToSupport(text, kb, parcel.id)) {
                await prisma.parcel.update({ where: { id: parcel.id }, data: { reviewOverdueAlertSentAt: now } });
                this.logEvent("logistics.parcel.review_overdue_alert_sent", "alertOverdueParcels", { parcelId: parcel.id });
            }
        }
    }

    /** Активні фотографині на зміні точки; одна людина — один раз, навіть із двома записами зміни. */
    private async staffOnShift(locationId: string, now: Date) {
        const { shiftStart, shiftEnd } = kyivShiftDateRange(now);
        const shifts = await prisma.workShift.findMany({
            where: { locationId, date: { gte: shiftStart, lt: shiftEnd }, staff: { isActive: true } },
            include: { staff: { include: { user: true } } },
        });
        const byStaff = new Map<string, { staffId: string; telegramId: bigint }>();
        for (const shift of shifts) {
            const telegramId = shift.staff?.user?.telegramId;
            if (telegramId) byStaff.set(shift.staffId, { staffId: shift.staffId, telegramId });
        }
        return [...byStaff.values()];
    }

    private manageKeyboard(parcelId: string) {
        return new InlineKeyboard().text("⚙️ Manage Parcel", `admin_parcel_view_details_${parcelId}`);
    }

    private async sendToStaff(telegramId: bigint, text: string, parcelId: string): Promise<boolean> {
        const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcelId));
        return bot.api.sendMessage(Number(telegramId), text, { parse_mode: "HTML", reply_markup: kb })
            .then(() => true)
            .catch(err => {
                logger.error({ err, parcelId, telegramId }, "Logistics delivered parcel staff message failed");
                return false;
            });
    }

    private async sendToSupport(text: string, kb: InlineKeyboard, parcelId: string): Promise<boolean> {
        return bot.api.sendMessage(TEAM_CHATS.SUPPORT, text, {
            parse_mode: "HTML",
            reply_markup: kb,
            ...(TEAM_CHATS.LOGISTICS !== undefined ? { message_thread_id: TEAM_CHATS.LOGISTICS } : {}),
        })
            .then(() => true)
            .catch(err => {
                logger.error({ err, parcelId }, "Logistics follow-up support message failed");
                return false;
            });
    }

    private logEvent(event: string, operation: string, safeContext: Record<string, unknown>) {
        logBusinessEvent({
            event,
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "parcel-followup-service",
            operation,
            safeContext,
        });
    }
}

export const parcelFollowupService = new ParcelFollowupService();
