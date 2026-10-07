import { describe, expect, it } from "vitest";
import { ukDays, ukPlural } from "../uk-plural.js";

describe("ukPlural", () => {
    it("declines 1/2/5/11/21/22", () => {
        const forms = { one: "зйомка", few: "зйомки", many: "зйомок" };
        expect([1, 2, 5, 11, 21, 22].map((n) => ukPlural(n, forms))).toEqual([
            "зйомка", "зйомки", "зйомок", "зйомок", "зйомка", "зйомки",
        ]);
    });

    it("says days the way the overdue reminder needs", () => {
        expect([1, 3, 7].map(ukDays)).toEqual(["1 день", "3 дні", "7 днів"]);
    });
});
