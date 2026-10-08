import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        parcel: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            update: (...a: unknown[]) => update(...a),
            findMany: (...a: unknown[]) => findMany(...a),
            updateMany: (...a: unknown[]) => updateMany(...a),
        },
    },
}));
vi.mock("../nova-poshta-service.js", () => ({ novaPoshtaService: {} }));
vi.mock("../parcel-canonical-read.js", () => ({ parcelCanonicalReadService: {} }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { logisticsService } = await import("../logistics-service.js");

type Service = {
    syncCanonicalLocations(parcels: Array<{ ttn: string; locationId: string | null }>): Promise<void>;
    cancelParcelsGoneFromWebapp(parcels: Array<{ ttn: string }>): Promise<void>;
    notifyStaffOnShift(parcelId: string, status: string): Promise<void>;
};
const service = logisticsService as unknown as Service;

const canonical = (locationId: string | null) => ({ ttn: "20451545104740", locationId });

beforeEach(() => {
    findUnique.mockReset();
    update.mockReset().mockResolvedValue({});
    findMany.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 0 });
    vi.restoreAllMocks();
});

// 01.10.2026: власник прив'язав 21 посилку до точки у вебаппі, а в боті вони
// лишились без точки — зміні не сказали, нагадувань не було.
describe("syncCanonicalLocations", () => {
    it("copies a location the web app assigned after the row was created", async () => {
        findUnique.mockResolvedValue({ id: "p1", locationId: null, status: "IN_TRANSIT" });
        const notify = vi.spyOn(service, "notifyStaffOnShift").mockResolvedValue();

        await service.syncCanonicalLocations([canonical("loc-kyiv")]);

        expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { locationId: "loc-kyiv" } });
        expect(notify).not.toHaveBeenCalled();
    });

    it("tells the shift about a parcel already waiting at the post office once it gets a location", async () => {
        findUnique.mockResolvedValue({ id: "p1", locationId: null, status: "ARRIVED" });
        const notify = vi.spyOn(service, "notifyStaffOnShift").mockResolvedValue();

        await service.syncCanonicalLocations([canonical("loc-kyiv")]);

        expect(notify).toHaveBeenCalledWith("p1", "ARRIVED");
    });

    it("follows the owner moving a parcel to another location, without a second arrival notice", async () => {
        findUnique.mockResolvedValue({ id: "p1", locationId: "loc-old", status: "ARRIVED" });
        const notify = vi.spyOn(service, "notifyStaffOnShift").mockResolvedValue();

        await service.syncCanonicalLocations([canonical("loc-new")]);

        expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { locationId: "loc-new" } });
        expect(notify).not.toHaveBeenCalled();
    });

    it("leaves closed parcels and unchanged locations alone", async () => {
        findUnique
            .mockResolvedValueOnce({ id: "p1", locationId: null, status: "COMPLETED" })
            .mockResolvedValueOnce({ id: "p2", locationId: "loc-kyiv", status: "ARRIVED" });

        await service.syncCanonicalLocations([canonical("loc-kyiv"), { ttn: "2", locationId: "loc-kyiv" }]);

        expect(update).not.toHaveBeenCalled();
    });

    it("does not erase a location when the web app has none", async () => {
        await service.syncCanonicalLocations([canonical(null)]);

        expect(findUnique).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });
});

// Посилку, скасовану у вебаппі (переадресація НП), вебапп перестає віддавати, а
// в боті вона висіла відкритою: «Посилки локації», кнопка «Прийняти».
describe("cancelParcelsGoneFromWebapp", () => {
    it("cancels an open parcel the web app no longer lists", async () => {
        findMany.mockResolvedValue([{ id: "p1", ttn: "111" }, { id: "p2", ttn: "222" }]);

        await service.cancelParcelsGoneFromWebapp([{ ttn: "111" }]);

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["p2"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
            data: { status: "CANCELLED" },
        });
    });

    it("touches nothing when the web app answers with an empty list", async () => {
        await service.cancelParcelsGoneFromWebapp([]);

        expect(findMany).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("treats a mass disappearance as a web app fault, not cancellations", async () => {
        findMany.mockResolvedValue(Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, ttn: `${i}` })));

        await service.cancelParcelsGoneFromWebapp([{ ttn: "known" }]);

        expect(updateMany).not.toHaveBeenCalled();
    });
});

// 08.10.2026: усі 38 кур'єрських посилок записані як 'Warehouse' — бот вгадував
// тип за npAddress, а адресу НП має й кур'єрська.
describe("syncCanonicalDeliveryTypes", () => {
    type DeliveryTypeService = {
        syncCanonicalDeliveryTypes(parcels: Array<{ ttn: string; deliveryType: string | null }>): Promise<void>;
    };
    const sync = (parcels: Array<{ ttn: string; deliveryType: string | null }>) =>
        (logisticsService as unknown as DeliveryTypeService).syncCanonicalDeliveryTypes(parcels);

    it("corrects an open parcel to the web app's delivery type", async () => {
        findUnique.mockResolvedValue({ id: "p1", deliveryType: "Warehouse", status: "DELIVERED" });

        await sync([{ ttn: "111", deliveryType: "Address" }]);

        expect(update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { deliveryType: "Address" } });
    });

    it("never touches closed parcels, matching values or a web app that does not know", async () => {
        findUnique
            .mockResolvedValueOnce({ id: "p1", deliveryType: "Warehouse", status: "COMPLETED" })
            .mockResolvedValueOnce({ id: "p2", deliveryType: "Warehouse", status: "CANCELLED" })
            .mockResolvedValueOnce({ id: "p3", deliveryType: "Address", status: "ARRIVED" });

        await sync([
            { ttn: "1", deliveryType: "Address" },
            { ttn: "2", deliveryType: "Address" },
            { ttn: "3", deliveryType: "Address" },
            { ttn: "4", deliveryType: null },
        ]);

        expect(findUnique).toHaveBeenCalledTimes(3);
        expect(update).not.toHaveBeenCalled();
    });
});
