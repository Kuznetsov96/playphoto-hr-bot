import { describe, expect, it } from "vitest";

import {
    canAcceptParcel,
    canMarkParcelPickedUpManually,
    initialParcelStatus,
    isParcelClosedForTracking,
    mapNpStatusCode,
    resolveParcelStatusTransition,
    selectTtnsClosedForTracking,
} from "../parcel-status-transition.js";

/**
 * Прод 20.09.2026, посылка cmu6u5cxo061lpt0l8myjdx2v:
 *
 *   17:24  фото сданы, статус VERIFYING
 *   18:34  саппорт подтвердил → COMPLETED
 *   18:55  синхронизация НП: COMPLETED -> DELIVERED   ← откат закрытой посылки
 *   20:30  фотограф снова в потоке «нужно фото»
 *
 * Закрытую посылку трекинг НП больше не открывает: приход и выдача в НП
 * происходят ДО подтверждения саппортом, поэтому её DELIVERED — это всегда
 * отставшая новость о уже прожитом этапе, а не новый факт.
 */
describe("resolveParcelStatusTransition", () => {
    it("keeps COMPLETED when Nova Poshta still reports DELIVERED", () => {
        expect(resolveParcelStatusTransition("COMPLETED", "DELIVERED", "Warehouse")).toBe("COMPLETED");
    });

    it("keeps COMPLETED for address delivery too", () => {
        expect(resolveParcelStatusTransition("COMPLETED", "DELIVERED", "Address")).toBe("COMPLETED");
    });

    it("keeps CANCELLED out of the tracking flow", () => {
        expect(resolveParcelStatusTransition("CANCELLED", "DELIVERED", "Warehouse")).toBe("CANCELLED");
    });

    it("still freezes VERIFYING while support reviews the photos", () => {
        expect(resolveParcelStatusTransition("VERIFYING", "DELIVERED", "Warehouse")).toBe("VERIFYING");
    });

    it("still lets a picked up parcel reach DELIVERED", () => {
        expect(resolveParcelStatusTransition("PICKUP_IN_PROGRESS", "DELIVERED", "Warehouse")).toBe("DELIVERED");
    });

    it("still moves an arrived warehouse parcel to DELIVERED", () => {
        expect(resolveParcelStatusTransition("ARRIVED", "DELIVERED", "Warehouse")).toBe("DELIVERED");
    });

    it("still tracks ordinary progress from Nova Poshta", () => {
        expect(resolveParcelStatusTransition("EXPECTED", "IN_TRANSIT", "Warehouse")).toBe("IN_TRANSIT");
    });
});

/**
 * Канонический список несёт статус ВЕБА, а веб про закрытие посылки не знает:
 * в его enum нет ни VERIFYING, ни COMPLETED — это состояния разговора, и
 * граница владения проведена сознательно (apps/api/src/logistics/
 * parcel-status-mapping.ts в репозитории вебаппа).
 *
 * Поэтому отбирать закрытые посылки можно только по статусу БОТА. Фильтр по
 * статусу из канонической выдачи не отсекал бы ничего и создавал ложное
 * ощущение защиты.
 */
describe("selectTtnsClosedForTracking", () => {
    it("picks the ttns the bot itself has already closed", () => {
        const local = new Map([
            ["TTN-DONE", "COMPLETED" as const],
            ["TTN-CANCELLED", "CANCELLED" as const],
            ["TTN-WAITING", "DELIVERED" as const],
        ]);

        expect(selectTtnsClosedForTracking(local)).toEqual(new Set(["TTN-DONE", "TTN-CANCELLED"]));
    });

    it("keeps a parcel under support review in tracking", () => {
        const local = new Map([["TTN-REVIEW", "VERIFYING" as const]]);

        expect(selectTtnsClosedForTracking(local)).toEqual(new Set());
    });

    it("returns nothing when the bot knows no parcel yet", () => {
        expect(selectTtnsClosedForTracking(new Map())).toEqual(new Set());
    });
});

/**
 * Кнопка саппорта «📬 Picked Up Manually» ставит DELIVERED и обнуляет отметки
 * об отправленных напоминаниях. От COMPLETED и CANCELLED она защищена, а
 * VERIFYING пропускала — хотя это «фото уже сданы, ждём подтверждения».
 *
 * Нажатие в этом окне сбивало статус назад и снимало защиту от напоминаний:
 * не так громко, как откат трекингом (тот бил по людям 20.09), но ровно то же
 * по сути — машина забывает, что человек свою часть уже сделал.
 */
describe("canMarkParcelPickedUpManually", () => {
    it("does not touch a parcel whose photos are awaiting support", () => {
        expect(canMarkParcelPickedUpManually("VERIFYING")).toBe(false);
    });

    it("does not touch a parcel support already confirmed", () => {
        expect(canMarkParcelPickedUpManually("COMPLETED")).toBe(false);
    });

    it("does not touch a cancelled parcel", () => {
        expect(canMarkParcelPickedUpManually("CANCELLED")).toBe(false);
    });

    it("still marks a parcel that is waiting to be picked up", () => {
        expect(canMarkParcelPickedUpManually("ARRIVED")).toBe(true);
    });

    it("still marks a parcel the photographer has taken on", () => {
        expect(canMarkParcelPickedUpManually("PICKUP_IN_PROGRESS")).toBe(true);
    });
});

/**
 * Переадресация НП, прод 30.09.2026: коробка 20400546955468 дважды сменила адрес
 * (→ 59001770706919 → 59001787984510). Код 104 «Змінено адресу» бот не знал и
 * превращал в EXPECTED: переадресованная накладная откатывалась из «прибыла» в
 * «ожидается», а смене уходило «очікується посилка» по коробке, которой в том
 * отделении уже нет.
 */
describe("Nova Poshta redirect (code 104)", () => {
    it("reads 104 as a redirect, not as EXPECTED", () => {
        expect(mapNpStatusCode("104")).toBe("REDIRECTED");
    });

    it("reads an unknown code as unknown", () => {
        expect(mapNpStatusCode("999")).toBeNull();
    });

    it.each(["EXPECTED", "IN_TRANSIT", "ARRIVED", "DELIVERED", "PICKUP_IN_PROGRESS"] as const)(
        "closes a %s parcel once it is redirected",
        (current) => {
            expect(resolveParcelStatusTransition(current, "REDIRECTED", "Warehouse")).toBe("CANCELLED");
        },
    );

    it.each(["VERIFYING", "COMPLETED"] as const)("keeps %s: the conversation is already done", (current) => {
        expect(resolveParcelStatusTransition(current, "REDIRECTED", "Warehouse")).toBe(current);
    });

    it("keeps the current status on an unknown code instead of rolling it back", () => {
        expect(resolveParcelStatusTransition("ARRIVED", null, "Warehouse")).toBe("ARRIVED");
    });

    it("opens a card for an already redirected waybill closed", () => {
        expect(initialParcelStatus("REDIRECTED")).toBe("CANCELLED");
        expect(initialParcelStatus(null)).toBe("EXPECTED");
        expect(initialParcelStatus("ARRIVED")).toBe("ARRIVED");
    });

    it("does not let an old «Так, заберу» button reopen a closed parcel", () => {
        expect(canAcceptParcel("CANCELLED")).toBe(false);
        expect(canAcceptParcel("COMPLETED")).toBe(false);
        expect(canAcceptParcel("VERIFYING")).toBe(false);
        expect(canAcceptParcel("ARRIVED")).toBe(true);
    });
});
