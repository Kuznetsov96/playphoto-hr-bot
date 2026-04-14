export const LOGISTICS_CALLBACK_DEBOUNCE_MS = 15_000;

function isRecentLogisticsAction(
    actionAt: Date | string | null | undefined,
    now: Date = new Date(),
) {
    if (!actionAt) return false;

    const actionTs = new Date(actionAt).getTime();
    if (Number.isNaN(actionTs)) return false;

    return now.getTime() - actionTs < LOGISTICS_CALLBACK_DEBOUNCE_MS;
}

export function isDuplicateParcelReject(
    lastRejectionAt: Date | string | null | undefined,
    now: Date = new Date(),
) {
    return isRecentLogisticsAction(lastRejectionAt, now);
}

export function isDuplicateParcelAccept(
    acceptedAt: Date | string | null | undefined,
    now: Date = new Date(),
) {
    return isRecentLogisticsAction(acceptedAt, now);
}

export function shouldEscalateRejectedParcel(previousRejectionCount: number, nextRejectionCount: number) {
    return previousRejectionCount < 2 && nextRejectionCount >= 2;
}

export function getParcelRejectConfirmationText(alreadyProcessed: boolean) {
    if (alreadyProcessed) {
        return `✅ <b>Відмову вже зафіксовано.</b>\n\nПовторно натискати не потрібно. Посилка залишається у списку локації, її зможе забрати інша фотографиня.`;
    }

    return `✅ <b>Відмову зафіксовано.</b>\n\nПосилка залишається у списку локації, її зможе забрати інша фотографиня. Повторно натискати не потрібно.`;
}

export function isDuplicateManualProxyRequest(
    lastAttemptAt: Date | string | null | undefined,
    trusteeError: string | null | undefined,
    requestedPhone: string,
    storedPhone: string | null | undefined,
    now: Date = new Date(),
) {
    if (trusteeError !== "MANUAL_PROXY_REQUESTED") return false;
    if (storedPhone !== requestedPhone) return false;

    return isRecentLogisticsAction(lastAttemptAt, now);
}

export function getManualProxyConfirmationText(alreadyProcessed: boolean) {
    if (alreadyProcessed) {
        return `✅ Запит на ручне доручення вже передано сапорту.\n\nПовторно натискати не потрібно. Щойно доручення підтвердять, я попрошу тебе додати фото вмісту посилки.`;
    }

    return `✅ Номер збережено, передаю сапорту задачу на ручне оформлення доручення в Новій Пошті.\n\nЩойно доручення підтвердять, я попрошу тебе додати фото вмісту посилки.`;
}
