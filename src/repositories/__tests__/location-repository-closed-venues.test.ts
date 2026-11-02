import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Закриту точку синк ховає (isHidden), але рядок лишається в базі. Списки міст і точок
 * для адмінських екранів мусять це поважати: у листопаді 2026 масова задача все ще
 * пропонувала Черкаси й Запоріжжя, де нас уже немає.
 */

const ROWS = [
    { id: "kyiv", city: "Kyiv", isHidden: false, isHiddenFromCandidates: false },
    { id: "cherkasy", city: "Cherkasy", isHidden: true, isHiddenFromCandidates: true },
    { id: "lviv-closed", city: "Lviv", isHidden: true, isHiddenFromCandidates: true },
    { id: "lviv-2", city: "Lviv", isHidden: false, isHiddenFromCandidates: true },
];

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../../db/core.js", () => ({ default: { location: { findMany } } }));

/** Виконує той самий where, що пішов би в базу, — перевіряємо результат, а не форму запиту. */
function applyWhere(args: { where?: Record<string, unknown>; distinct?: string[] }) {
    const rows = ROWS.filter(row =>
        Object.entries(args.where ?? {}).every(([key, value]) => (row as Record<string, unknown>)[key] === value),
    );
    return args.distinct ? [...new Map(rows.map(row => [row.city, row])).values()] : rows;
}

async function freshRepository() {
    vi.resetModules();
    return (await import("../location-repository.js")).locationRepository;
}

describe("locationRepository — закриті точки", () => {
    beforeEach(() => {
        findMany.mockReset();
        findMany.mockImplementation(async (args: Parameters<typeof applyWhere>[0]) => applyWhere(args));
    });

    it("findAllCities() не віддає місто, де всі точки закриті", async () => {
        const repository = await freshRepository();
        expect(await repository.findAllCities()).toEqual(["Kyiv", "Lviv"]);
    });

    it("findAllCities(false) для керування показує і закриті", async () => {
        const repository = await freshRepository();
        expect(await repository.findAllCities(false)).toEqual(["Kyiv", "Cherkasy", "Lviv"]);
    });

    it("findAllCities(true, true) для анкети лишає лише відкриті кандидаткам", async () => {
        const repository = await freshRepository();
        expect(await repository.findAllCities(true, true)).toEqual(["Kyiv"]);
    });

    it("findByCity() не віддає закриту точку міста, де є відкрита", async () => {
        const repository = await freshRepository();
        expect((await repository.findByCity("Lviv")).map(row => row.id)).toEqual(["lviv-2"]);
    });

    it("findByCityAdmin() для керування показує і закриті", async () => {
        const repository = await freshRepository();
        expect((await repository.findByCityAdmin("Lviv")).map(row => row.id)).toEqual(["lviv-closed", "lviv-2"]);
    });

    it("findCityUkLabels() віддає місто → назву лише для непорожніх cityUk", async () => {
        findMany.mockReset();
        findMany.mockResolvedValue([
            { city: "Dnipro", cityUk: "Дніпро" },
            { city: "Kyiv", cityUk: null },
        ]);
        const repository = await freshRepository();
        expect(await repository.findCityUkLabels()).toEqual(new Map([["Dnipro", "Дніпро"]]));
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { cityUk: { not: null } },
        }));
    });
});
