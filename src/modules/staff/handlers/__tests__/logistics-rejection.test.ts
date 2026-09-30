import { describe, expect, it } from "vitest";

import {
    getManualProxyConfirmationText,
    getParcelRejectConfirmationText,
    isDuplicateManualProxyRequest,
    isDuplicateParcelAccept,
    isDuplicateParcelReject,
    isParcelPhotoAlreadySubmitted,
    getParcelPhotoAlreadySubmittedText,
    LOGISTICS_CALLBACK_DEBOUNCE_MS,
    shouldEscalateRejectedParcel,
} from "../logistics-rejection.js";

describe("logistics rejection helpers", () => {
    it("treats quick repeated taps as duplicate rejects", () => {
        const now = new Date("2026-04-14T07:45:00.000Z");
        const lastRejectAt = new Date(now.getTime() - (LOGISTICS_CALLBACK_DEBOUNCE_MS - 1000));

        expect(isDuplicateParcelReject(lastRejectAt, now)).toBe(true);
    });

    it("allows a new reject after the debounce window expires", () => {
        const now = new Date("2026-04-14T07:45:00.000Z");
        const lastRejectAt = new Date(now.getTime() - (LOGISTICS_CALLBACK_DEBOUNCE_MS + 1000));

        expect(isDuplicateParcelReject(lastRejectAt, now)).toBe(false);
    });

    it("treats quick repeated accepts as duplicate taps", () => {
        const now = new Date("2026-04-14T07:45:00.000Z");
        const acceptedAt = new Date(now.getTime() - (LOGISTICS_CALLBACK_DEBOUNCE_MS - 1000));

        expect(isDuplicateParcelAccept(acceptedAt, now)).toBe(true);
    });

    it("escalates support only on the first critical rejection threshold", () => {
        expect(shouldEscalateRejectedParcel(1, 2)).toBe(true);
        expect(shouldEscalateRejectedParcel(2, 3)).toBe(false);
        expect(shouldEscalateRejectedParcel(3, 4)).toBe(false);
    });

    it("treats repeated manual proxy request with same phone as duplicate", () => {
        const now = new Date("2026-04-14T07:45:00.000Z");
        const attemptedAt = new Date(now.getTime() - (LOGISTICS_CALLBACK_DEBOUNCE_MS - 1000));

        expect(isDuplicateManualProxyRequest(
            attemptedAt,
            "MANUAL_PROXY_REQUESTED",
            "380991234567",
            "380991234567",
            now,
        )).toBe(true);
    });

    it("returns distinct confirmation text for duplicate taps", () => {
        expect(getParcelRejectConfirmationText(false)).toContain("Відмову зафіксовано");
        expect(getParcelRejectConfirmationText(true)).toContain("Відмову вже зафіксовано");
        expect(getManualProxyConfirmationText(false)).toContain("передаю сапорту");
        expect(getManualProxyConfirmationText(true)).toContain("вже передано сапорту");
    });
});

/**
 * Прод 20.09.2026, 17:24 (telegram_id 719611958, посылка cmu6u5cxo061lpt0l8myjdx2v):
 * два фото попали в черновик, "Готово" отработало успешно за 0.5 с, а через 1.6 с
 * прилетело второе нажатие по той же кнопке — черновик уже очищен, и бот ответил
 * "Спочатку надішли хоча б одне фото", хотя фото уже были у саппорта.
 *
 * Состояние посылки — единственный признак, переживающий очистку черновика и сессии.
 */
describe("parcel photo done, repeated tap", () => {
    it("treats a tap on an already submitted parcel as done, not as missing photos", () => {
        expect(isParcelPhotoAlreadySubmitted("VERIFYING", ["file-1", "file-2"])).toBe(true);
    });

    it("still asks for photos when the parcel carries no content photos yet", () => {
        expect(isParcelPhotoAlreadySubmitted("DELIVERED", [])).toBe(false);
    });

    it("does not treat a parcel awaiting photos as submitted even with stale photo ids", () => {
        expect(isParcelPhotoAlreadySubmitted("DELIVERED", ["file-1"])).toBe(false);
    });

    it("tells the photographer the photos already reached support", () => {
        expect(getParcelPhotoAlreadySubmittedText(2)).toContain("вже передано сапорту");
    });
});
