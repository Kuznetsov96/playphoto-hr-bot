import type { ParcelStatus } from "@prisma/client";

/**
 * Посылка закрыта: трекинг НП её больше не касается.
 *
 * Спрашивать об этом можно только статус БОТА. Веб о закрытии не знает: в его
 * enum нет ни VERIFYING, ни COMPLETED — это состояния разговора, и граница
 * владения проведена сознательно (см. parcel-status-mapping.ts в вебаппе:
 * «веб владеет фактами НП, бот владеет разговором»).
 */
export function isParcelClosedForTracking(status: ParcelStatus): boolean {
    return status === 'COMPLETED' || status === 'CANCELLED';
}

/**
 * ТТН, которые бот у себя уже закрыл, — их не нужно ни опрашивать в НП, ни
 * тем более переоткрывать.
 *
 * Принимает статусы из базы бота (ttn → status), потому что канонический
 * список несёт статус веба, а он для закрытой посылки навсегда остаётся
 * DELIVERED. Фильтр по нему не отсекал бы ничего.
 */
export function selectTtnsClosedForTracking(
    localStatusByTtn: ReadonlyMap<string, ParcelStatus>,
): Set<string> {
    const closed = new Set<string>();
    for (const [ttn, status] of localStatusByTtn) {
        if (isParcelClosedForTracking(status)) closed.add(ttn);
    }
    return closed;
}

/**
 * Разрешает переход статуса посылки по данным трекинга Новой Пошты.
 *
 * Охраняет состояние разговора от НП: трекинг ничего не знает про то, забрала ли
 * посылку фотографиня, сданы ли фото и подтвердил ли их саппорт.
 *
 * Правила:
 * - COMPLETED / CANCELLED: посылка закрыта, трекинг её больше не открывает;
 * - VERIFYING: фото сданы, ждём саппорта — заморозка;
 * - PICKUP_IN_PROGRESS: посылку забирают, НП DELIVERED означает факт выдачи;
 * - адресная доставка: DELIVERED от курьера открывает поток фото;
 * - отделение/почтомат: DELIVERED/COMPLETED от НП означает выдачу.
 */
export function resolveParcelStatusTransition(
    currentStatus: ParcelStatus,
    npStatus: ParcelStatus,
    deliveryType: string | null,
): ParcelStatus {
    // Закрытая посылка: приход и выдача в НП происходят ДО подтверждения
    // саппортом, поэтому её DELIVERED — отставшая новость об уже прожитом
    // этапе, а не новый факт. Без этой ветки трекинг откатывал COMPLETED в
    // DELIVERED, посылка снова попадала в выборки напоминаний, и фотографиня
    // через час-другой получала «завантаж фото» по уже сданной посылке
    // (прод 20.09.2026, cmu6u5cxo061lpt0l8myjdx2v).
    if (currentStatus === 'COMPLETED' || currentStatus === 'CANCELLED') {
        return currentStatus;
    }

    // VERIFYING: photos uploaded, awaiting admin — freeze completely
    if (currentStatus === 'VERIFYING') {
        return currentStatus;
    }

    // PICKUP_IN_PROGRESS: staff accepted. Allow NP DELIVERED through —
    // it means parcel was physically picked up from NP.
    if (currentStatus === 'PICKUP_IN_PROGRESS') {
        return npStatus === 'DELIVERED' ? 'DELIVERED' : currentStatus;
    }

    // Address delivery: NP gives DELIVERED when courier drops off.
    // This is legitimate — let it through so staff gets notified to upload photo.
    if (npStatus === 'DELIVERED' && deliveryType === 'Address') {
        return 'DELIVERED';
    }

    // For warehouse/postomat parcels, DELIVERED/COMPLETED means the parcel was already
    // handed out by Nova Poshta. Don't send staff into trustee flow again.
    if (npStatus === 'DELIVERED' || npStatus === 'COMPLETED') {
        if (currentStatus === 'EXPECTED' || currentStatus === 'IN_TRANSIT' || currentStatus === 'ARRIVED') {
            return 'DELIVERED';
        }
    }

    return npStatus;
}
