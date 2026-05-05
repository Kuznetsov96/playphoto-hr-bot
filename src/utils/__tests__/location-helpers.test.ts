import { describe, expect, it } from "vitest";
import { getShortLocationName } from "../location-helpers.js";

describe("getShortLocationName", () => {
    it("numbers Volkland locations consistently", () => {
        expect(getShortLocationName("Volkland", "Запоріжжя")).toBe("Volkland 1");
        expect(getShortLocationName("Volkland 1 (Бабурка)", "Запоріжжя")).toBe("Volkland 1");
        expect(getShortLocationName("Volkland 2 (Шевчик)", "Запоріжжя")).toBe("Volkland 2");
        expect(getShortLocationName("Volkland 3 (Перемоги)", "Запоріжжя")).toBe("Volkland 3");
    });
});
