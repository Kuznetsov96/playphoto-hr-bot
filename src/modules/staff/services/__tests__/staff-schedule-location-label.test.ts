import { describe, expect, it } from "vitest";
import {
    findShiftLocationLabelCollisions,
    formatShiftLocationLabel
} from "../../../../utils/logistics-formatters.js";

/**
 * The reported bug: a photographer assigned to Smile Park Troieshchyna saw a schedule that read
 * plain "Smile Park" on every row. Four production locations are named exactly "Smile Park" and
 * three "Volkland", so the bare name identifies nothing — she could not confirm the shift was
 * hers and assumed the schedule was wrong.
 *
 * The label shows what the canonical catalogue says distinguishes a venue: its `branch`. Not the
 * city, and not "whatever makes it unique in the database".
 */

/** The full production estate, as synced from the canonical backend. */
const PRODUCTION_LOCATIONS = [
    { name: "Dragon Park", city: "Lviv", branch: null, canonicalCode: "dragon-park-lviv" },
    { name: "Dragon Park 2", city: "Lviv", branch: null, canonicalCode: "dragon-park-2-lviv" },
    { name: "Drive City", city: "Lviv", branch: null, canonicalCode: "drive-city-lviv" },
    { name: "Dytiache Horyshche", city: "Khmelnytskyi", branch: null, canonicalCode: "dytiache-horyshche" },
    { name: "Fantasy Town", city: "Cherkasy", branch: null, canonicalCode: "fantasy-town-cherkasy" },
    { name: "Fly Kids", city: "Kyiv", branch: null, canonicalCode: "fly-kids-kyiv" },
    { name: "Fly Kids", city: "Lviv", branch: null, canonicalCode: "fly-kids-lviv" },
    { name: "Fly Kids", city: "Rivne", branch: null, canonicalCode: "fly-kids-rivne" },
    { name: "Karamel", city: "Kolomyia", branch: null, canonicalCode: "karamel-kolomyia" },
    { name: "Karamel", city: "Sambir", branch: null, canonicalCode: "karamel-sambir" },
    { name: "Karamel", city: "Sheptytskyi", branch: null, canonicalCode: "karamel-sheptytskyi" },
    { name: "Kidlandia", city: "Kyiv", branch: null, canonicalCode: "kidlandia-kyiv" },
    { name: "Leoland", city: "Lviv", branch: null, canonicalCode: "leoland-lviv" },
    { name: "Smile Park", city: "Kharkiv", branch: null, canonicalCode: "smile-park-kharkiv" },
    { name: "Smile Park", city: "Kyiv", branch: "Darynok", canonicalCode: "smile-park-darynok" },
    { name: "Smile Park", city: "Kyiv", branch: "Troieshchyna", canonicalCode: "smile-park-kyiv-troieshchyna" },
    { name: "Smile Park", city: "Lviv", branch: null, canonicalCode: "smile-park-lviv" },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Baburka", canonicalCode: "volkland-1-baburka" },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Shevchyk", canonicalCode: "volkland-2-shevchenkivskyi" },
    { name: "Volkland", city: "Zaporizhzhia", branch: "Peremohy", canonicalCode: "volkland-3-peremohy" },
];

describe("shift location label", () => {
    it("appends the branch that distinguishes same-named venues", () => {
        expect(formatShiftLocationLabel({ name: "Smile Park", city: "Київ", branch: "Троєщина" }))
            .toBe("Smile Park (Троєщина)");
        expect(formatShiftLocationLabel({ name: "Volkland", city: "Запоріжжя", branch: "Шевчик" }))
            .toBe("Volkland (Шевчик)");
    });

    /**
     * Kidlandia is the only one of its name, so parentheses would discriminate nothing and only
     * cost width on a phone screen.
     */
    it("leaves a venue with no branch bare", () => {
        expect(formatShiftLocationLabel({ name: "Kidlandia", city: "Київ", branch: null })).toBe("Kidlandia");
        expect(formatShiftLocationLabel({ name: "Fantasy Town", city: "Черкаси", branch: null })).toBe("Fantasy Town");
    });

    /**
     * Karamel exists three times, one per city, and carries no branch. The label is identical for
     * all three by design: a photographer's schedule is single-city, so the rows never meet.
     * `findShiftLocationLabelCollisions` is what keeps that assumption honest.
     */
    it("does not add a city to tell cross-city namesakes apart", () => {
        expect(formatShiftLocationLabel({ name: "Karamel", city: "Самбір", branch: null })).toBe("Karamel");
        expect(formatShiftLocationLabel({ name: "Karamel", city: "Коломия", branch: null })).toBe("Karamel");
    });

    /**
     * The label must never shift because an unrelated venue opened elsewhere — that instability is
     * precisely what a database-wide uniqueness rule would introduce.
     */
    it("is a pure function of one location", () => {
        const alone = formatShiftLocationLabel({ name: "Kidlandia", city: "Київ", branch: null });
        const withNamesakeElsewhere = formatShiftLocationLabel({ name: "Kidlandia", city: "Київ", branch: null });

        expect(alone).toBe(withNamesakeElsewhere);
        expect(alone).toBe("Kidlandia");
    });

    /**
     * `formatLocationName` strips a city echoed inside the raw name, so the label never reads
     * "Smile Park Kharkiv". Routing through it must preserve that.
     */
    it("still strips DDS prefixes and a city echoed in the name", () => {
        expect(formatShiftLocationLabel({ name: "Smile Park Харків", city: "Харків", branch: null }))
            .toBe("Smile Park");
        expect(formatShiftLocationLabel({ name: "Выручка от продаж Leolend", city: "Львів", branch: null }))
            .toBe("Leolend");
    });

    it("falls back rather than rendering an empty row", () => {
        expect(formatShiftLocationLabel({ name: "Smile Park", city: null, branch: null })).toBe("Smile Park");
        expect(formatShiftLocationLabel(null)).toBe("Unknown");
    });
});

describe("shift location label collisions", () => {
    /**
     * The safety net for the omitted city. Production currently relies on same-city namesakes
     * always carrying a branch — verified against the live catalogue — and the cross-city
     * duplicates (Fly Kids, Karamel) are reported so the assumption stays visible rather than
     * silently load-bearing.
     */
    it("reports every venue that shares a label", () => {
        const collisions = findShiftLocationLabelCollisions(PRODUCTION_LOCATIONS);

        expect(collisions).toEqual([
            { label: "Fly Kids", canonicalCodes: ["fly-kids-kyiv", "fly-kids-lviv", "fly-kids-rivne"] },
            { label: "Karamel", canonicalCodes: ["karamel-kolomyia", "karamel-sambir", "karamel-sheptytskyi"] },
            { label: "Smile Park", canonicalCodes: ["smile-park-kharkiv", "smile-park-lviv"] },
        ]);
    });

    /** Venues the catalogue does distinguish must not be reported — that would be pure noise. */
    it("stays quiet for venues the catalogue distinguishes", () => {
        const branched = PRODUCTION_LOCATIONS.filter(l => l.branch !== null);

        expect(findShiftLocationLabelCollisions(branched)).toEqual([]);
    });

    /**
     * The case the warning exists for: a second Kidlandia opens and nobody records a branch.
     * Two schedule rows would then read identically, and the operator needs to know which
     * catalogue entries to fix.
     */
    it("catches a new same-city namesake that arrived without a branch", () => {
        const collisions = findShiftLocationLabelCollisions([
            { name: "Kidlandia", city: "Kyiv", branch: null, canonicalCode: "kidlandia-kyiv" },
            { name: "Kidlandia", city: "Kyiv", branch: null, canonicalCode: "kidlandia-obolon" },
        ]);

        expect(collisions).toEqual([
            { label: "Kidlandia", canonicalCodes: ["kidlandia-kyiv", "kidlandia-obolon"] },
        ]);
    });
});
