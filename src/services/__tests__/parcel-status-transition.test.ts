import { describe, expect, it } from "vitest";

import { isParcelClosedForTracking, resolveParcelStatusTransition } from "../parcel-status-transition.js";

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
 * Вторая половина той же дыры: канонический список активных посылок приходит из
 * вебаппа, а он отфильтровывает только CANCELLED и отдаёт COMPLETED (см.
 * BotParcelsService.parcels в репозитории вебаппа). Legacy-выборка бота
 * исключала оба статуса — при переходе на канонический источник фильтр потерялся.
 */
describe("isParcelClosedForTracking", () => {
    it("excludes a parcel support already confirmed", () => {
        expect(isParcelClosedForTracking("COMPLETED")).toBe(true);
    });

    it("excludes a cancelled parcel", () => {
        expect(isParcelClosedForTracking("CANCELLED")).toBe(true);
    });

    it("keeps tracking a parcel still awaiting photos", () => {
        expect(isParcelClosedForTracking("DELIVERED")).toBe(false);
    });

    it("keeps tracking a parcel under support review", () => {
        expect(isParcelClosedForTracking("VERIFYING")).toBe(false);
    });
});
