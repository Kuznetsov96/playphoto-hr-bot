import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Кнопки міст в анкеті: підпис українською, у сесію й базу — канонічне
 * латинське значення (аудит 01.10.2026). Раніше кандидатка бачила
 * «Zaporizhzhia», «Kolomyya» — ключі з бази, а не назви міст.
 */

const dynamics = vi.hoisted(() => new Map<string, (ctx: any, range: any) => unknown>());

vi.mock("@grammyjs/menu", () => ({
    Menu: class {
        constructor(public id: string, _options?: unknown) {}
        register() { return this; }
        text() { return this; }
        row() { return this; }
        dynamic(fn: (ctx: any, range: any) => unknown) { dynamics.set(this.id, fn); return this; }
    },
}));

const { findAllCities, findByCity, findCityUkLabels, persistCandidate, handleNoVacancies } = vi.hoisted(() => ({
    findCityUkLabels: vi.fn(),
    findAllCities: vi.fn(),
    findByCity: vi.fn(),
    persistCandidate: vi.fn(),
    handleNoVacancies: vi.fn(),
}));

vi.mock("../../repositories/location-repository.js", () => ({ locationRepository: { findAllCities, findByCity, findCityUkLabels } }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen: vi.fn(), goBack: vi.fn() } }));
vi.mock("../../utils/menu-registry.js", () => ({ menuRegistry: { register: vi.fn() } }));
vi.mock("../../modules/candidate/handlers/index.js", () => ({
    persistCandidate,
    handleNoVacancies,
    questionnaireClosed: vi.fn(async () => false),
}));

function fakeRange() {
    const buttons: Array<{ label: string; handler?: (ctx: any) => unknown }> = [];
    const range: any = {
        text(label: string, handler?: (ctx: any) => unknown) { buttons.push({ label, ...(handler ? { handler } : {}) }); return range; },
        row() { return range; },
    };
    return { range, buttons };
}

describe("candidate-city menu", () => {
    beforeEach(() => {
        findAllCities.mockReset();
        findByCity.mockReset();
        findCityUkLabels.mockReset();
        findCityUkLabels.mockResolvedValue(new Map());
        persistCandidate.mockReset();
        handleNoVacancies.mockReset();
    });

    it("показывает города по-украински, а пишет каноническое значение", async () => {
        await import("../candidate.js");
        const render = dynamics.get("candidate-city")!;
        findAllCities.mockResolvedValue(["Kolomyya", "Zaporizhzhia"]);
        findByCity.mockResolvedValue([]);

        const { range, buttons } = fakeRange();
        await render({}, range);

        expect(buttons.map((b) => b.label)).toEqual(["Коломия", "Запоріжжя", "Назад"]);

        const ctx: any = { session: { candidateData: {} } };
        await buttons[1]!.handler!(ctx);

        expect(ctx.session.candidateData.city).toBe("Zaporizhzhia");
        expect(persistCandidate).toHaveBeenCalledWith(ctx, { city: "Zaporizhzhia", locationId: null, additionalLocationIds: [] });
        expect(handleNoVacancies).toHaveBeenCalledWith(ctx, "Zaporizhzhia");
    });

    it("підпис міста береться зі довідника, у сесію пишеться канонічне значення", async () => {
        await import("../candidate.js");
        const render = dynamics.get("candidate-city")!;
        findAllCities.mockResolvedValue(["Dnipro"]);
        findCityUkLabels.mockResolvedValue(new Map([["Dnipro", "Дніпро"]]));
        findByCity.mockResolvedValue([]);

        const { range, buttons } = fakeRange();
        await render({}, range);
        expect(buttons.map((b) => b.label)).toEqual(["Дніпро", "Назад"]);

        const ctx: any = { session: { candidateData: {} } };
        await buttons[0]!.handler!(ctx);
        expect(ctx.session.candidateData.city).toBe("Dnipro");
    });
});
