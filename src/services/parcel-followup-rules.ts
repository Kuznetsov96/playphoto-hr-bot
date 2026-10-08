import type { ParcelStatus } from "@prisma/client";

/**
 * Скільки посилка може чекати фото (DELIVERED) або підтвердження фото
 * (VERIFYING), перш ніж підтримка отримає сигнал. Рішення власника 08.10.2026.
 */
export const PARCEL_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * День зміни за Києвом як межі для WorkShift.date (UTC-північ дати).
 * Після 20:00 за Києвом це вже завтрашня зміна: сьогоднішня закінчилась, і
 * писати їй про посилку пізно.
 */
export function kyivShiftDateRange(now: Date): { shiftStart: Date; shiftEnd: Date } {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Kyiv",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "numeric", hour12: false,
    }).formatToParts(now);

    let y = 0, mo = 0, d = 0, h = 0;
    for (const p of parts) {
        if (p.type === "year") y = parseInt(p.value);
        if (p.type === "month") mo = parseInt(p.value);
        if (p.type === "day") d = parseInt(p.value);
        if (p.type === "hour") h = parseInt(p.value);
    }

    if (h >= 20) d++;
    return {
        shiftStart: new Date(Date.UTC(y, mo - 1, d)),
        shiftEnd: new Date(Date.UTC(y, mo - 1, d + 1)),
    };
}

export function isSameKyivShiftDay(a: Date, b: Date): boolean {
    return kyivShiftDateRange(a).shiftStart.getTime() === kyivShiftDateRange(b).shiftStart.getTime();
}

/**
 * Поля, які ставляться разом зі входом у DELIVERED. Відлік і однократні
 * сигнали належать саме цьому перебуванню в статусі: посилка, що вийшла з
 * DELIVERED і повернулась, рахується заново. Повторна позначка того самого
 * статусу (саппорт двічі натиснув «Picked Up Manually») відлік не зсуває.
 */
export function deliveredEntryData(previousStatus: ParcelStatus, now: Date) {
    if (previousStatus === "DELIVERED") return {};
    return {
        deliveredAt: now,
        claimPromptedAt: null,
        outsidePickupAlertSentAt: null,
        photoOverdueAlertSentAt: null,
    };
}

/** Те саме для VERIFYING: дозавантажені фото не зсувають «чекає з». */
export function verifyingEntryData(previousStatus: ParcelStatus, now: Date) {
    if (previousStatus === "VERIFYING") return {};
    return { verifyingSince: now, reviewOverdueAlertSentAt: null };
}

export interface DeliveredParcelFacts {
    status: ParcelStatus;
    contentPhotoCount: number;
    responsibleStaffId: string | null;
    locationId: string | null;
    deliveryType: string | null;
    deliveredAt: Date | null;
    claimPromptedAt: Date | null;
    outsidePickupAlertSentAt: Date | null;
}

export type DeliveredParcelAction =
    | { kind: "none" }
    /** Одна людина на зміні: посилка її, пишемо їй. */
    | { kind: "assign" }
    /** Кілька людей: пишемо всім, бере та, хто перша почне фото. */
    | { kind: "prompt_claim" }
    /** Відділення/поштомат: НП видала, а через «Забрати» ніхто не проходив. */
    | { kind: "alert_outside_pickup" };

/**
 * Що робити з посилкою, яка вже на точці (DELIVERED), але без фото й без
 * відповідальної. Відповідальна з'являлась лише через «Забрати» у відділенні,
 * тож кур'єрські посилки й забрані повз бота після одного повідомлення зміні
 * випадали з усіх нагадувань: одна так пролежала 3,5 тижні.
 */
export function decideDeliveredParcelAction(
    parcel: DeliveredParcelFacts,
    shiftCount: number,
    now: Date,
): DeliveredParcelAction {
    if (parcel.status !== "DELIVERED") return { kind: "none" };
    if (parcel.contentPhotoCount > 0) return { kind: "none" };
    if (parcel.responsibleStaffId !== null) return { kind: "none" };
    if (parcel.locationId === null) return { kind: "none" };

    if (parcel.deliveryType === "Address") {
        // Нікого на зміні — мовчимо: 3-денний сигнал підтримці про це й є.
        if (shiftCount === 0) return { kind: "none" };
        if (shiftCount === 1) return { kind: "assign" };
        if (parcel.claimPromptedAt && isSameKyivShiftDay(parcel.claimPromptedAt, now)) {
            return { kind: "none" };
        }
        return { kind: "prompt_claim" };
    }

    if (parcel.outsidePickupAlertSentAt !== null) return { kind: "none" };
    // Посилка, що вже чекає довше за поріг (такі приходять бекфілом при
    // виході), отримає сигнал «3 дні без фото» — другий лист про те саме
    // підтримці не потрібен.
    if (parcel.deliveredAt && now.getTime() - parcel.deliveredAt.getTime() > PARCEL_OVERDUE_MS) {
        return { kind: "none" };
    }
    return { kind: "alert_outside_pickup" };
}

export interface OverdueParcelFacts {
    status: ParcelStatus;
    contentPhotoCount: number;
    deliveredAt: Date | null;
    verifyingSince: Date | null;
    photoOverdueAlertSentAt: Date | null;
    reviewOverdueAlertSentAt: Date | null;
}

export type OverdueAlertKind = "PHOTO_OVERDUE" | "REVIEW_OVERDUE";

function isOlderThanThreshold(since: Date | null, now: Date): boolean {
    return since !== null && now.getTime() - since.getTime() > PARCEL_OVERDUE_MS;
}

/** Який однократний сигнал підтримці належить посилці зараз (або жодного). */
export function selectOverdueAlert(parcel: OverdueParcelFacts, now: Date): OverdueAlertKind | null {
    if (
        parcel.status === "DELIVERED" &&
        parcel.contentPhotoCount === 0 &&
        parcel.photoOverdueAlertSentAt === null &&
        isOlderThanThreshold(parcel.deliveredAt, now)
    ) {
        return "PHOTO_OVERDUE";
    }
    if (
        parcel.status === "VERIFYING" &&
        parcel.reviewOverdueAlertSentAt === null &&
        isOlderThanThreshold(parcel.verifyingSince, now)
    ) {
        return "REVIEW_OVERDUE";
    }
    return null;
}

/** «5 Oct 2026 (3 days ago)» — для англомовних повідомлень підтримці. */
export function formatSupportDateAgo(at: Date, now: Date): string {
    const date = at.toLocaleDateString("en-GB", {
        timeZone: "Europe/Kyiv", day: "numeric", month: "short", year: "numeric",
    });
    const days = Math.floor((now.getTime() - at.getTime()) / DAY_MS);
    const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
    return `${date} (${ago})`;
}
