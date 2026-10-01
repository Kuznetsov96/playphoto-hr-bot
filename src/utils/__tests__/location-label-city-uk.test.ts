import { describe, expect, it } from "vitest";

import { formatCityUk } from "../location-label.js";

describe("formatCityUk", () => {
    it("канонические значения показываются по-украински", () => {
        expect(["Kyiv", "Lviv", "Zaporizhzhia", "Kolomyya", "Khmelnytskyi", "Cherkasy", "Rivne", "Sambir", "Sheptytskyi", "Kharkiv", "Chortkiv", "Ternopil"].map(formatCityUk))
            .toEqual(["Київ", "Львів", "Запоріжжя", "Коломия", "Хмельницький", "Черкаси", "Рівне", "Самбір", "Шептицький", "Харків", "Чортків", "Тернопіль"]);
    });

    it("варианты из CITY_MAP и уже украинское имя дают то же; неизвестное — как есть", () => {
        expect(formatCityUk("Kolomyia")).toBe("Коломия");
        expect(formatCityUk("Львів")).toBe("Львів");
        expect(formatCityUk("Odesa")).toBe("Odesa");
    });
});
