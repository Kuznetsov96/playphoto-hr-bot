import { describe, expect, it } from "vitest";
import { buildParcelLocationChoices } from "../parcel-location-picker.js";

/**
 * Экран «Set Location» показывал сырое `location.name`, и менеджер видел список, в котором
 * три Karamel, четыре Smile Park и три Volkland ничем не отличались друг от друга. Выбирать
 * приходилось наугад, а ошибка тут дорогая: посылка уезжает не на ту точку.
 *
 * Канонический `formatLocation(loc, "listing")` для этого уже существовал и использовался
 * на соседних экранах логистики — список посылок показывает «Karamel (Atlant) (Sambir)».
 * Пикер был единственным местом, которое его обходило.
 */

/** Живой справочник, снятый с прода 14.08.2026 — тот же, что и в format-location.test.ts. */
const PRODUCTION_LOCATIONS = [
    { id: "1", name: "Fantasy Town", city: "Cherkasy", branch: null },
    { id: "2", name: "Smile Park", city: "Kharkiv", branch: "Nikolsky" },
    { id: "3", name: "Dytiache Horyshche", city: "Khmelnytskyi", branch: null },
    { id: "4", name: "Karamel", city: "Kolomyia", branch: "Prut" },
    { id: "5", name: "Fly Kids", city: "Kyiv", branch: "Dniprovskyi" },
    { id: "6", name: "Kidlandia", city: "Kyiv", branch: null },
    { id: "7", name: "Smile Park", city: "Kyiv", branch: "Troieshchyna" },
    { id: "8", name: "Smile Park", city: "Kyiv", branch: "Darynok" },
    { id: "9", name: "Dragon Park", city: "Lviv", branch: null },
    { id: "10", name: "Dragon Park 2", city: "Lviv", branch: null },
    { id: "11", name: "Drive City", city: "Lviv", branch: null },
    { id: "12", name: "Fly Kids", city: "Lviv", branch: null },
    { id: "13", name: "Leoland", city: "Lviv", branch: null },
    { id: "14", name: "Smile Park", city: "Lviv", branch: "Forum Lviv" },
    { id: "15", name: "Fly Kids", city: "Rivne", branch: "Arena" },
    { id: "16", name: "Karamel", city: "Sambir", branch: "Atlant" },
    { id: "17", name: "Karamel", city: "Sheptytskyi", branch: null },
    { id: "18", name: "Volkland", city: "Zaporizhzhia", branch: "Peremohy" },
    { id: "19", name: "Volkland", city: "Zaporizhzhia", branch: "Shevchyk" },
    { id: "20", name: "Volkland", city: "Zaporizhzhia", branch: "Baburka" },
];

describe("buildParcelLocationChoices", () => {
    /**
     * Главное свойство экрана: ни одна кнопка не повторяет другую. Проверяется на всём
     * справочнике целиком, а не на паре примеров, — именно полный список и сломался.
     */
    it("даёт каждой локации прода различимую подпись", () => {
        const labels = buildParcelLocationChoices(PRODUCTION_LOCATIONS).map((choice) => choice.label);

        expect(new Set(labels).size).toBe(PRODUCTION_LOCATIONS.length);
    });

    it("называет город и филиал у одноимённых точек", () => {
        const labels = buildParcelLocationChoices(PRODUCTION_LOCATIONS).map((choice) => choice.label);

        expect(labels).toContain("Karamel (Atlant) (Sambir)");
        expect(labels).toContain("Karamel (Prut) (Kolomyya)");
        expect(labels).toContain("Volkland (Baburka) (Zaporizhzhia)");
    });

    /** Три Volkland подряд читаются как один блок, только если список сгруппирован по городу. */
    it("группирует по городу, а внутри города — по подписи", () => {
        const choices = buildParcelLocationChoices(PRODUCTION_LOCATIONS);
        const kyivRange = choices.filter((choice) => choice.label.includes("(Kyiv)"));
        const firstKyiv = choices.findIndex((choice) => choice.label.includes("(Kyiv)"));

        // Город идёт непрерывным блоком, без вклинивания чужих строк.
        expect(choices.slice(firstKyiv, firstKyiv + kyivRange.length)).toEqual(kyivRange);
        expect(kyivRange.map((choice) => choice.label)).toEqual([
            "Fly Kids (Dniprovskyi) (Kyiv)",
            "Kidlandia (Kyiv)",
            "Smile Park (Darynok) (Kyiv)",
            "Smile Park (Troieshchyna) (Kyiv)",
        ]);
    });

    it("сохраняет id локации для callback-кнопки", () => {
        const choices = buildParcelLocationChoices(PRODUCTION_LOCATIONS);
        const sambir = choices.find((choice) => choice.label === "Karamel (Atlant) (Sambir)");

        expect(sambir?.id).toBe("16");
    });
});
