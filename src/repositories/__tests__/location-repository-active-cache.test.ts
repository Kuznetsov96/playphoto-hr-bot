import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, update } = vi.hoisted(() => ({
    findMany: vi.fn(),
    update: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {
        location: {
            findMany,
            update,
        },
    },
}));

const SAMPLE_LOCATIONS = [
    { id: "loc-1", name: "Obolon", city: "Kyiv", legacyName: null, isHidden: false, hasAcquiring: false, fopId: null },
    { id: "loc-2", name: "Podil", city: "Kyiv", legacyName: null, isHidden: false, hasAcquiring: false, fopId: null },
];

/**
 * `findAllActive()`'s cache is module-level state (like `findAllCities()`'s), so each test
 * re-imports the repository module fresh — `vi.resetModules()` plus a dynamic import — to
 * start from an empty cache instead of fighting the 30s TTL left over from a previous test.
 */
async function freshRepository() {
    vi.resetModules();
    const mod = await import("../location-repository.js");
    return mod.locationRepository;
}

describe("locationRepository.findAllActive — TTL cache", () => {
    beforeEach(() => {
        findMany.mockReset();
        update.mockReset();
        findMany.mockResolvedValue(SAMPLE_LOCATIONS);
        update.mockResolvedValue(SAMPLE_LOCATIONS[0]);
    });

    it("hits the database once for many calls within the TTL window", async () => {
        // Simulates the bulk-task wizard: one findLocationsInCities() per checkbox tap
        // (recipient toggle, scope-all, city toggle-all, etc.) within the same short flow.
        const locationRepository = await freshRepository();

        await locationRepository.findAllActive();
        await locationRepository.findAllActive();
        await locationRepository.findAllActive();
        await locationRepository.findAllActive();

        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("still applies the same hidden-locations filter as before caching", async () => {
        const locationRepository = await freshRepository();

        await locationRepository.findAllActive();

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { isHidden: false },
        }));
    });

    it("returns the same enriched shape (fopId/hasAcquiring) from the cached path", async () => {
        const locationRepository = await freshRepository();

        const [first] = await locationRepository.findAllActive();
        const [second] = await locationRepository.findAllActive();

        expect(first).toHaveProperty("hasAcquiring");
        expect(first).toHaveProperty("fopId");
        expect(second).toEqual(first);
    });

    it("update() invalidates the cache so an edited location shows up immediately, not after 30s", async () => {
        const locationRepository = await freshRepository();

        await locationRepository.findAllActive();
        expect(findMany).toHaveBeenCalledTimes(1);

        findMany.mockResolvedValueOnce([
            ...SAMPLE_LOCATIONS,
            { id: "loc-3", name: "New Spot", city: "Lviv", legacyName: null, isHidden: false, hasAcquiring: false, fopId: null },
        ]);
        await locationRepository.update("loc-1", { name: "Obolon Updated" } as any);

        const result = await locationRepository.findAllActive();
        expect(findMany).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(3);
    });
});
