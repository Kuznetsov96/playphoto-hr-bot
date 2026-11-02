import { describe, expect, it } from "vitest";

import { formatCityUk } from "../location-label.js";

describe("formatCityUk", () => {
    it("показує Миргород українською, а не латиницею з бази", () => {
        expect(formatCityUk("Myrhorod")).toBe("Миргород");
        expect(formatCityUk("Миргород")).toBe("Миргород");
    });

    it("канонические значения показываются по-украински", () => {
        expect(["Kyiv", "Lviv", "Zaporizhzhia", "Kolomyya", "Khmelnytskyi", "Cherkasy", "Rivne", "Sambir", "Sheptytskyi", "Kharkiv", "Chortkiv", "Ternopil"].map((city) => formatCityUk(city)))
            .toEqual(["Київ", "Львів", "Запоріжжя", "Коломия", "Хмельницький", "Черкаси", "Рівне", "Самбір", "Шептицький", "Харків", "Чортків", "Тернопіль"]);
    });

    it("варианты из CITY_MAP и уже украинское имя дают то же; неизвестное — как есть", () => {
        expect(formatCityUk("Kolomyia")).toBe("Коломия");
        expect(formatCityUk("Львів")).toBe("Львів");
        expect(formatCityUk("Odesa")).toBe("Odesa");
    });

    it("назва зі довідника має пріоритет над статичною картою", () => {
        expect(formatCityUk("Dnipro", "Дніпро")).toBe("Дніпро");
        expect(formatCityUk("Kyiv", "Київ")).toBe("Київ");
    });

    it("без назви зі довідника — статична карта як страховка", () => {
        expect(formatCityUk("Dnipro", null)).toBe("Dnipro");
        expect(formatCityUk("Kolomia", undefined)).toBe("Kolomia");
        expect(formatCityUk("Kolomyia", null)).toBe("Коломия");
        expect(formatCityUk("Dnipro", "  ")).toBe("Dnipro");
    });
});
