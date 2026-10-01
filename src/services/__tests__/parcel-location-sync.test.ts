import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        parcel: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            update: (...a: unknown[]) => update(...a),
        },
    },
}));
vi.mock("../nova-poshta-service.js", () => ({ novaPoshtaService: {} }));
vi.mock("../parcel-canonical-read.js", () => ({ parcelCanonicalReadService: {} }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { logisticsService } = await import("../logistics-service.js");

type Service = {
    syncCanonicalLocations(parcels: Array<{ ttn: string; locationId: string | null }>): Promise<void>;
    notifyStaffOnShift(parcelId: string, status: string): Promise<void>;
};
const service = logisticsService as unknown as Service;

const canonical = (locationId: string | null) => ({ ttn: "20451545104740", locationId });

beforeEach(() => {
    findUnique.mockReset();
    update.mockReset().mockResolvedValue({});
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
