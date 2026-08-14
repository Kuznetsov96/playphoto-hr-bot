import { describe, expect, it } from "vitest";
import { formatLocation } from "../utils.js";

/**
 * One formatter, three display contexts. Before this existed the codebase had four ways to render
 * a location and two of them worked by appending the city and then cutting it back off with a
 * regex or a suffix comparison — a sure sign the missing piece was a parameter, not a helper.
 *
 * The contexts differ only in how the city is shown, because that is the only thing that ever
 * varied:
 *
 *   in-city    Fly Kids                  — the screen already names the city
 *   listing    Fly Kids (Lviv)           — a picker spanning cities
 *   sentence   Fly Kids, Lviv            — prose, reports, notifications
 *
 * The venue part — DDS cleanup, city echoed inside the raw name, the canonical `branch` — is
 * identical in all three.
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

describe("formatLocation — the venue part, shared by every context", () => {
    it("appends the branch that distinguishes same-named venues", () => {
        expect(formatLocation({ name: "Volkland", city: "Запоріжжя", branch: "Шевчик" }, "in-city"))
            .toBe("Volkland (Шевчик)");
        expect(formatLocation({ name: "Smile Park", city: "Київ", branch: "Троєщина" }, "in-city"))
            .toBe("Smile Park (Троєщина)");
    });

    /** Kidlandia is the only one of its name; parentheses would discriminate nothing. */
    it("leaves a venue with no branch bare", () => {
        expect(formatLocation({ name: "Kidlandia", city: "Київ", branch: null }, "in-city")).toBe("Kidlandia");
        expect(formatLocation({ name: "Dragon Park", city: "Львів" }, "in-city")).toBe("Dragon Park");
    });

    it("strips DDS prefixes and a city echoed inside the raw name", () => {
        expect(formatLocation({ name: "Выручка от продаж Leolend", city: "Львів" }, "in-city")).toBe("Leolend");
        expect(formatLocation({ name: "Smile Park Харків", city: "Харків" }, "in-city")).toBe("Smile Park");
        expect(formatLocation({ name: "Выручка от продаж Leolend", city: "Львів" }, "listing"))
            .toBe("Leolend (Lviv)");
    });

    /**
     * The old code rewrote a bare "Volkland" to "Volkland 1", turning "branch unknown" into a
     * confident and often wrong "1". It must stay gone.
     */
    it("never invents a discriminator of its own", () => {
        expect(formatLocation({ name: "Volkland", city: "Запоріжжя", branch: null }, "listing"))
            .toBe("Volkland (Zaporizhzhia)");
    });
});

describe("formatLocation — city per context", () => {
    const volkland = { name: "Volkland", city: "Запоріжжя", branch: "Шевчик" };

    it("omits the city where the screen already establishes it", () => {
        expect(formatLocation(volkland, "in-city")).toBe("Volkland (Шевчик)");
    });

    it("parenthesises the city for cross-city pickers", () => {
        expect(formatLocation(volkland, "listing")).toBe("Volkland (Шевчик) (Zaporizhzhia)");
    });

    it("uses a comma for prose", () => {
        expect(formatLocation(volkland, "sentence")).toBe("Volkland (Шевчик), Zaporizhzhia");
    });

    it("normalises the city to English in every context that shows one", () => {
        expect(formatLocation({ name: "Leoland", city: "Львів" }, "listing")).toBe("Leoland (Lviv)");
        expect(formatLocation({ name: "Leoland", city: "Львів" }, "sentence")).toBe("Leoland, Lviv");
    });

    it("drops the emoji cities carry in the catalogue", () => {
        expect(formatLocation({ name: "Smile Park", city: "🎓 Kharkiv", branch: "Nikolsky" }, "listing"))
            .toBe("Smile Park (Nikolsky) (Kharkiv)");
    });
});

describe("formatLocation — degenerate input", () => {
    it("renders the bare name when the city is missing", () => {
        expect(formatLocation({ name: "Smile Park", city: null }, "listing")).toBe("Smile Park");
        expect(formatLocation({ name: "Smile Park", city: "" }, "sentence")).toBe("Smile Park");
    });

    it("falls back rather than rendering an empty row", () => {
        expect(formatLocation(null, "in-city")).toBe("Unknown");
        expect(formatLocation({ name: null, city: "Львів" }, "in-city")).toBe("Unknown");
    });

    /** A raw name that was nothing but the city must not collapse to an empty string. */
    it("keeps something readable when the name is only a city", () => {
        expect(formatLocation({ name: "Львів", city: "Львів" }, "in-city")).not.toBe("");
    });

    it("ignores a whitespace-only branch", () => {
        expect(formatLocation({ name: "Kidlandia", city: "Київ", branch: "   " }, "in-city")).toBe("Kidlandia");
    });
});

describe("formatLocation — the label is a pure function of one location", () => {
    /**
     * It must never shift because an unrelated venue opened elsewhere — the instability a
     * database-wide uniqueness rule would introduce.
     */
    it("does not consult the rest of the catalogue", () => {
        const alone = formatLocation({ name: "Kidlandia", city: "Київ", branch: null }, "in-city");
        const withNamesakeElsewhere = formatLocation({ name: "Kidlandia", city: "Київ", branch: null }, "in-city");

        expect(alone).toBe(withNamesakeElsewhere);
        expect(alone).toBe("Kidlandia");
    });

    /**
     * Karamel appears in three cities and Fly Kids in three more. In `in-city` their labels
     * collide by design: a photographer's schedule is single-city, so the rows never meet.
     * `findShiftLocationLabelCollisions` is what keeps that assumption honest.
     */
    it("does not add a city to tell cross-city namesakes apart in-city", () => {
        expect(formatLocation({ name: "Karamel", city: "Самбір", branch: null }, "in-city")).toBe("Karamel");
        expect(formatLocation({ name: "Karamel", city: "Коломия", branch: null }, "in-city")).toBe("Karamel");
    });
});

describe("formatLocation — against the live catalogue", () => {
    /**
     * The guarantee that matters for the admin pickers and the photographer schedule alike:
     * inside one city, no two venues render the same. This is what makes dropping the city from
     * those screens safe.
     */
    it("never renders two venues in one city identically", () => {
        const byCity = new Map<string, string[]>();
        for (const location of PRODUCTION_LOCATIONS) {
            const labels = byCity.get(location.city) ?? [];
            labels.push(formatLocation(location, "in-city"));
            byCity.set(location.city, labels);
        }

        for (const [city, labels] of byCity) {
            expect(new Set(labels).size, `duplicate label in ${city}: ${labels.join(" / ")}`).toBe(labels.length);
        }
    });

    /** And across the whole estate once the city is shown, which is the cross-city picker's job. */
    it("never renders two venues identically once the city is shown", () => {
        const labels = PRODUCTION_LOCATIONS.map((location) => formatLocation(location, "listing"));

        expect(new Set(labels).size).toBe(labels.length);
    });
});
