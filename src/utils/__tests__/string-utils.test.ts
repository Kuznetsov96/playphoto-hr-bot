import { describe, expect, it } from "vitest";

import { formatSurnameNameDot } from "../string-utils.js";

describe("formatSurnameNameDot", () => {
    it("formats Ukrainian full names for schedule tables", () => {
        expect(formatSurnameNameDot("Брагіна Олександра Сергіївна")).toBe("Брагіна О.");
        expect(formatSurnameNameDot("Іванова Євгенія Олександрівна")).toBe("Іванова Є.");
        expect(formatSurnameNameDot("Хілінська Дар'я Віталіївна")).toBe("Хілінська Д.");
    });

    it("keeps single-token names as-is", () => {
        expect(formatSurnameNameDot("Брагіна")).toBe("Брагіна");
        expect(formatSurnameNameDot("")).toBe("");
    });
});
