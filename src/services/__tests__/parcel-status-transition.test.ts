import { describe, expect, it } from "vitest";

import {
    isParcelClosedForTracking,
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
