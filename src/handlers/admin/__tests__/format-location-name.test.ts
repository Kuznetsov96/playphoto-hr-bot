import { describe, expect, it } from "vitest";
import { formatLocationName } from "../utils.js";

describe("formatLocationName with a canonical branch", () => {
    /**
     * The reported bug: all three Zaporizhzhia Volklands rendered as one identical
     * "Volkland 1 (Zaporizhzhia)" button. Canonically they share `name` and differ only
     * by `branch`, so the branch has to reach the label.
     */
    it("tells the three Volklands apart by branch", () => {
        const rendered = [
            formatLocationName("Volkland", "Запоріжжя", "Бабурка"),
            formatLocationName("Volkland", "Запоріжжя", "Шевчик"),
            formatLocationName("Volkland", "Запоріжжя", "Перемоги"),
        ];

        expect(rendered).toEqual([
            "Volkland (Бабурка) (Zaporizhzhia)",
            "Volkland (Шевчик) (Zaporizhzhia)",
            "Volkland (Перемоги) (Zaporizhzhia)",
        ]);
        expect(new Set(rendered).size).toBe(3);
    });

    it("omits the branch when the location has none", () => {
        expect(formatLocationName("Dragon Park", "Львів", null)).toBe("Dragon Park (Lviv)");
        expect(formatLocationName("Dragon Park", "Львів")).toBe("Dragon Park (Lviv)");
    });

    /**
     * The old code rewrote a bare "Volkland" to "Volkland 1". That invented a fact: it turned
     * "branch unknown" into a confident, often wrong "1". With the branch synced it must stop.
     */
    it("no longer invents a number for an unbranded Volkland", () => {
        expect(formatLocationName("Volkland", "Запоріжжя", null)).toBe("Volkland (Zaporizhzhia)");
    });

    it("still strips DDS prefixes and duplicated city names", () => {
        expect(formatLocationName("Выручка от продаж Leolend", "Львів", null)).toBe("Leolend (Lviv)");
        expect(formatLocationName("Smile Park Харків", "Харків", null)).toBe("Smile Park (Kharkiv)");
    });
});
