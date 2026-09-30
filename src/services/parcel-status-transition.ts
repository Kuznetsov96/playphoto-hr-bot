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
 * Можно ли отметить посылку выданной вручную (кнопка саппорта «Picked Up
 * Manually»).
 *
 * Нельзя, как только фотограф сдала фото: отметка ставит DELIVERED и обнуляет
 * `photoReminderSentAt` / `shiftEndReminderSentAt`, то есть откатывает статус
 * назад и заново открывает напоминания по посылке, с которой человек уже
 * закончил. VERIFYING («фото сданы, ждём саппорта») здесь равноценен
 * закрытому: содержимое подтверждать нечем — оно уже у саппорта.
 */
export function canMarkParcelPickedUpManually(status: ParcelStatus): boolean {
    return !isParcelClosedForTracking(status) && status !== 'VERIFYING';
}

/**
 * Можно ли взять посылку кнопкой «Так, заберу».
 *
 * Нельзя у закрытой (в том числе переадресованной — она закрыта в CANCELLED) и у
 * той, по которой фото уже сданы: кнопка из старого сообщения переоткрыла бы её в
 * PICKUP_IN_PROGRESS и вернула в напоминания.
 */
export function canAcceptParcel(status: ParcelStatus): boolean {
    return !isParcelClosedForTracking(status) && status !== 'VERIFYING';
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
 * Что сказал трекинг НП о накладной, в терминах бота.
 *
 * - `ParcelStatus` — обычный этап доставки;
 * - `'REDIRECTED'` — код 104 «Змінено адресу»: НП завела на ту же коробку НОВУЮ
 *   накладную, эта больше никуда не едет;
 * - `null` — код, которого бот не знает.
 *
 * Отдельный тип, а не ParcelStatus: до 30.09.2026 незнакомый код (в том числе 104)
 * превращался в EXPECTED, и переадресованная посылка откатывалась из «прибыла» в
 * «ожидается» с сообщением смене — по коробке, которой в отделении уже нет
 * (прод, ТТН 59001770706919 → 59001787984510).
 */
export type NpTrackingObservation = ParcelStatus | 'REDIRECTED' | null;

export function mapNpStatusCode(statusCode: string): NpTrackingObservation {
    switch (statusCode) {
        case '1': return 'EXPECTED';
        case '4':
        case '5':
        case '6': return 'IN_TRANSIT';
        case '7':
        case '8': return 'ARRIVED';
        case '9': return 'DELIVERED';
        case '10':
        case '11': return 'COMPLETED';
        case '104': return 'REDIRECTED';
        default: return null;
    }
}

/**
 * Что сказал трекинг о накладной, с учётом переадресации.
 *
 * Переадресацию выдаёт ссылка на новую накладную, а не код: 104 НП держит, только пока коробка
 * едет под новым номером, а когда её забрали, старая накладная показывает тот же 9 «Отримано»,
 * что и новая (прод 30.09.2026: 6 из 8 переадресованных накладных). По коду бот открыл бы по
 * старой накладной второй поток «завантаж фото» на ту же коробку.
 */
export function observeNpTracking(doc: {
    StatusCode: string;
    LastCreatedOnTheBasisDocumentType?: string;
    LastCreatedOnTheBasisDateTime?: string;
    DateCreated?: string;
}): NpTrackingObservation {
    if (isRedirectedAway(doc)) return 'REDIRECTED';
    return mapNpStatusCode(doc.StatusCode);
}

/**
 * Эта накладная переадресована — коробка уехала под НОВОЙ.
 *
 * Ссылка `LastCreatedOnTheBasis*` связывает накладные цепочки в обе стороны: у старой она
 * называет новую, а у новой — ту, из которой её создали. 30.09.2026 это приняли за переадресацию
 * и закрыли живую посылку (59001787984510). Направление — по датам: переадресована, если
 * связанную накладную создали ПОЗЖЕ этой. Нет дат — не гадаем, посылка живая.
 */
function isRedirectedAway(doc: {
    LastCreatedOnTheBasisDocumentType?: string;
    LastCreatedOnTheBasisDateTime?: string;
    DateCreated?: string;
}): boolean {
    if (doc.LastCreatedOnTheBasisDocumentType !== 'Redirecting') return false;
    const created = npTime(doc.DateCreated);
    const basisCreated = npTime(doc.LastCreatedOnTheBasisDateTime);
    if (created === null || basisCreated === null) return false;
    return basisCreated > created;
}

/** «2026-09-27 14:35:14» и «27-09-2026 14:35:14» (НП пишет оба) → сравнимое число; иначе null. */
function npTime(value: string | undefined): number | null {
    if (value === undefined) return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
    const dmy = /^(\d{2})[.-](\d{2})[.-](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
    const parts = iso
        ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
        : dmy
          ? [dmy[3], dmy[2], dmy[1], dmy[4], dmy[5], dmy[6]]
          : null;
    if (parts === null) return null;
    const [year, month, day, hour, minute, second] = parts;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0));
}

/**
 * Статус новой карточки. Незнакомый код — EXPECTED, как раньше: о карточке смене
 * ничего не сообщается, а следующий опрос поправит статус. Переадресованная
 * накладная заводится сразу закрытой: коробка едет под другим номером, и та
 * накладная придёт в бот своей карточкой.
 */
export function initialParcelStatus(observation: NpTrackingObservation): ParcelStatus {
    if (observation === null) return 'EXPECTED';
    if (observation === 'REDIRECTED') return 'CANCELLED';
    return observation;
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
 * - отделение/почтомат: DELIVERED/COMPLETED от НП означает выдачу;
 * - переадресация (104): накладная закрывается, коробка едет под новой;
 * - незнакомый код: статус не трогаем.
 */
export function resolveParcelStatusTransition(
    currentStatus: ParcelStatus,
    npStatus: NpTrackingObservation,
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

    // Незнакомый код не повод что-то менять: раньше он становился EXPECTED и
    // откатывал «прибыла» в «ожидается».
    if (npStatus === null) {
        return currentStatus;
    }

    // Переадресация: коробка уехала под новой накладной. Закрываем эту — в том
    // числе у того, кто уже собрался её забирать (PICKUP_IN_PROGRESS): в старом
    // отделении забирать нечего, а новая накладная придёт своей карточкой с
    // обычным «прибыла». CANCELLED смене ничего не шлёт.
    if (npStatus === 'REDIRECTED') {
        return 'CANCELLED';
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
