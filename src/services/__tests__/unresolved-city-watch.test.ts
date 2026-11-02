import { describe, expect, it, vi } from "vitest";

vi.mock("../../repositories/system-state-repository.js", () => ({
    systemStateRepository: { getJson: vi.fn(), setJson: vi.fn() },
}));

const {
    findUnresolvedCities,
    pickCitiesToAlert,
    buildCityAlertText,
    UNRESOLVED_CITIES_KEY,
    LAST_ALERT_KEY,
    runUnresolvedCityCheck,
} = await import("../unresolved-city-watch.js");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

describe("findUnresolvedCities", () => {
    it("находит только строгий null", () => {
        const result = findUnresolvedCities([
            { city: "Dnipro", name: "Volkland", cityUk: null },
            { city: "Kyiv", name: "A", cityUk: "Київ" },
            { city: "Lviv", name: "B" },
            { city: "Odesa", name: "C", cityUk: undefined },
        ]);
        expect(result).toEqual([{ city: "Dnipro", locationName: "Volkland" }]);
    });
});

describe("pickCitiesToAlert", () => {
    const unresolved = [{ city: "Dnipro", locationName: "Volkland" }];
    it("город без записи — алертить", () => {
        expect(pickCitiesToAlert(unresolved, {}, NOW)).toEqual(["Dnipro"]);
    });
    it("запись младше 24 ч — молчать", () => {
        expect(pickCitiesToAlert(unresolved, { Dnipro: hoursAgo(23) }, NOW)).toEqual([]);
    });
    it("запись старше 24 ч — алертить снова", () => {
        expect(pickCitiesToAlert(unresolved, { Dnipro: hoursAgo(25) }, NOW)).toEqual(["Dnipro"]);
    });
    it("один город на нескольких точках — один раз", () => {
        const two = [...unresolved, { city: "Dnipro", locationName: "Other" }];
        expect(pickCitiesToAlert(two, {}, NOW)).toEqual(["Dnipro"]);
    });
});

describe("buildCityAlertText", () => {
    it("текст по-украински с названием точки", () => {
        expect(buildCityAlertText("Dnipro", "Volkland")).toBe("⚠️ Місто Dnipro немає в довіднику, точка Volkland");
    });
});

it("ключи состояния", () => {
    expect(UNRESOLVED_CITIES_KEY).toBe("aws-business-sync:unresolved-cities");
    expect(LAST_ALERT_KEY).toBe("unresolved-cities:last-alert");
});

describe("runUnresolvedCityCheck", () => {
    const makeStore = (data: Record<string, unknown>) => ({
        getJson: vi.fn(async (key: string) => (data[key] ?? null) as never),
        setJson: vi.fn(async (key: string, value: unknown) => { data[key] = value; }),
    });
    const list = [{ city: "Dnipro", locationName: "Volkland" }];

    it("город вернулся в норму: запись удаляется из last-alert", async () => {
        const store = makeStore({ [UNRESOLVED_CITIES_KEY]: [], [LAST_ALERT_KEY]: { Dnipro: hoursAgo(1) } });
        const api = { sendMessage: vi.fn() };
        await runUnresolvedCityCheck({ api, adminIds: [1], store, now: NOW });
        expect(store.setJson).toHaveBeenCalledWith(LAST_ALERT_KEY, {});
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("в пределах 24 ч не повторяет", async () => {
        const store = makeStore({ [UNRESOLVED_CITIES_KEY]: list, [LAST_ALERT_KEY]: { Dnipro: hoursAgo(2) } });
        const api = { sendMessage: vi.fn() };
        await runUnresolvedCityCheck({ api, adminIds: [1], store, now: NOW });
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(store.setJson).not.toHaveBeenCalled();
    });

    it("шлёт только владельцу и записывает город", async () => {
        const store = makeStore({ [UNRESOLVED_CITIES_KEY]: list });
        const api = { sendMessage: vi.fn().mockResolvedValue(undefined) };
        await runUnresolvedCityCheck({ api, adminIds: [1, 2], store, now: NOW });
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledWith(1, "⚠️ Місто Dnipro немає в довіднику, точка Volkland");
        expect(store.setJson).toHaveBeenCalledWith(LAST_ALERT_KEY, { Dnipro: NOW.toISOString() });
    });

    it("полный сбой отправки: не бросает, город не записан", async () => {
        const store = makeStore({ [UNRESOLVED_CITIES_KEY]: list });
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("boom")) };
        await expect(runUnresolvedCityCheck({ api, adminIds: [1], store, now: NOW })).resolves.toBeUndefined();
        expect(store.setJson).not.toHaveBeenCalled();
    });
});
