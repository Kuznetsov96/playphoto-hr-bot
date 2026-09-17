/**
 * Behavioral proof that the two literal double-fetches the audit flagged are gone:
 * tbk_cities_toggle_all used to call findAllCities() once to decide "select all" and then
 * renderCitySelection called it again for the same tap; tbk_scope_all used to call
 * findAllActive() once via findLocationsInCities and renderRecipientSelection called it
 * again. Both now pass the already-fetched list through instead of refetching.
 *
 * Dispatches real callback_query updates through taskBulkHandlers, following the harness
 * in task-callback-role-guard.test.ts (the only place in this codebase that runs a real
 * grammY Composer dispatch in a unit test) rather than a fake context invented per-test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyContext } from "../../../types/context.js";

const { findAllCities, findAllActive } = vi.hoisted(() => ({
    findAllCities: vi.fn(),
    findAllActive: vi.fn(),
}));

vi.mock("../../../repositories/location-repository.js", () => ({
    locationRepository: { findAllCities, findAllActive },
}));

vi.mock("../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findWithShiftAtLocations: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../utils/screen-manager.js", () => ({
    ScreenManager: { renderScreen: vi.fn().mockResolvedValue(undefined), goBack: vi.fn().mockResolvedValue(undefined) },
}));

import { taskBulkHandlers } from "../task-bulk.js";

function contextFor(data: string, bulkTaskData: any) {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const ctx = {
        from: { id: 777 },
        update: { update_id: 1, callback_query: { data } },
        callbackQuery: { data },
        match: data.match(/^tbk_city_(.+)$/) || undefined,
        session: { bulkTaskData },
        answerCallbackQuery,
        has(filter: string) {
            return filter === "callback_query:data";
        },
    };
    return ctx as unknown as MyContext;
}

const KYIV_LOCATIONS = [
    { id: "loc-1", city: "Київ", name: "Obolon" },
    { id: "loc-2", city: "Київ", name: "Podil" },
];

describe("task-bulk.ts — no duplicate location-catalogue fetch within one tap", () => {
    beforeEach(() => {
        findAllCities.mockReset();
        findAllActive.mockReset();
        findAllCities.mockResolvedValue(["Київ", "Львів"]);
        findAllActive.mockResolvedValue(KYIV_LOCATIONS);
    });

    it("tbk_cities_toggle_all fetches the city catalogue once, not twice, per tap", async () => {
        const ctx = contextFor("tbk_cities_toggle_all", { cities: [], locationIds: [], excludedStaffIds: [] });

        await taskBulkHandlers.middleware()(ctx, async () => {});

        expect(findAllCities).toHaveBeenCalledTimes(1);
    });

    it("tbk_scope_all fetches the active-locations catalogue once, not twice, per tap", async () => {
        const ctx = contextFor("tbk_scope_all", { date: "2026-09-20", cities: ["Київ"], locationIds: [], excludedStaffIds: [] });

        await taskBulkHandlers.middleware()(ctx, async () => {});

        expect(findAllActive).toHaveBeenCalledTimes(1);
    });
});
