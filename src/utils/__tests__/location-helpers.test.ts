import { describe, expect, it } from "vitest";
import { getShortLocationName } from "../location-helpers.js";

/**
 * The compact label used where a row is already crowded — HR and mentor candidate lists, the
 * hiring-needs board — where the full name would crowd out the candidate's own name.
 *
 * It used to take `(name, city)` and derive the discriminator from the name itself: an old
 * catalogue spelled the Zaporizhzhia venues "Volkland 1 (Бабурка)", "Volkland 2 (Шевчик)", so a
 * digit search worked. The canonical catalogue renamed all three to a plain "Volkland" and moved
 * what tells them apart into `branch`. The digit search then found nothing and fell through to
 * its default — labelling all three "Volkland 1", including the two that are not.
 *
 * So the discriminator comes from `branch` now, the same source every other label uses.
 */

/** The live catalogue, read from production on 2026-08-14. */
const PRODUCTION_LOCATIONS = [
    { name: "Fantasy Town", city: "Cherkasy", branch: null },
    { name: "Smile Park", city: "Kharkiv", branch: "Nikolsky" },
    { name: "Dytiache Horyshche", city: "Khmelnytskyi", branch: null },
    { name: "Karamel", city: "Kolomyia", branch: "Prut" },
    { name: "Fly Kids", city: "Kyiv", branch: "Dniprovskyi" },
    { name: "Kidlandia", city: "Kyiv", branch: null },
    { name: "Smile Park", city: "Kyiv", branch: "Troieshchyna" },
    { name: "Smile Park", city: "Kyiv", branch: "Darynok" },
    { name: "Dragon Park", city: "Lviv", branch: null },
    { name: "Dragon Park 2", city: "Lviv", branch: null },
    { name: "Drive City", city: "Lviv", branch: null },
    { name: "Fly Kids", city: "Lviv", branch: null },
    { name: "Leoland", city: "Lviv", branch: null },
    { name: "Smile Park", city: "Lviv", branch: "Forum Lviv" },
    { name: "Fly Kids", city: "Rivne", branch: "Arena" },
    { name: "Karamel", city: "Sambir", branch: "Atlant" },
    { name: "Karamel", city: "Sheptytskyi", branch: null },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Peremohy" },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Shevchyk" },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Baburka" },
];

describe("getShortLocationName", () => {
    /** The regression that prompted this: three venues, one label, two of them wrong. */
    it("tells the three Zaporizhzhia Volklands apart by branch", () => {
        const rendered = PRODUCTION_LOCATIONS.filter((l) => l.name === "Volkland").map(
            (l) => getShortLocationName(l.name, l.city, l.branch)
        );

        expect(rendered).toEqual(["Volkland Peremohy", "Volkland Shevchyk", "Volkland Baburka"]);
        expect(new Set(rendered).size).toBe(3);
    });

    it("never invents a number for a venue whose branch is unknown", () => {
        expect(getShortLocationName("Volkland", "Запоріжжя", null)).toBe("Volkland");
    });

    it("keeps the abbreviation and appends the branch", () => {
        expect(getShortLocationName("Smile Park", "Київ", "Троєщина")).toBe("SP Троєщина");
        expect(getShortLocationName("Smile Park", "Київ", "Darynok")).toBe("SP Darynok");
        expect(getShortLocationName("Fly Kids", "Рівне", "Arena")).toBe("FK Arena");
        expect(getShortLocationName("Karamel", "Самбір", "Atlant")).toBe("Карамель Atlant");
    });

    it("leaves a venue with no branch as the bare abbreviation", () => {
        expect(getShortLocationName("Kidlandia", "Київ", null)).toBe("Kidlandia");
        expect(getShortLocationName("Leoland", "Львів", null)).toBe("Leo");
        expect(getShortLocationName("Fantasy Town", "Черкаси", null)).toBe("FT");
    });

    /**
     * "Dragon Park" and "Dragon Park 2" are two venues in Lviv, distinguished by the name itself
     * rather than a branch. Abbreviating both to "Dragon" merged them.
     */
    it("does not merge two venues whose names differ", () => {
        expect(getShortLocationName("Dragon Park", "Львів", null)).not.toBe(
            getShortLocationName("Dragon Park 2", "Львів", null)
        );
    });

    it("falls back rather than rendering an empty label", () => {
        expect(getShortLocationName(null, "Львів", null)).toBe("—");
        expect(getShortLocationName(undefined, undefined, undefined)).toBe("—");
    });

    /**
     * The compact label is always printed next to a city code, so it only has to be unambiguous
     * within one city — but the whole estate passing is the stronger guarantee, and it holds.
     */
    it("renders every production venue distinctly", () => {
        const labels = PRODUCTION_LOCATIONS.map((l) => getShortLocationName(l.name, l.city, l.branch));

        expect(new Set(labels).size).toBe(labels.length);
    });
});
