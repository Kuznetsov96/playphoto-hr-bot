import { describe, expect, it } from "vitest";
import {
    BIRTH_MONTH_LABELS,
    buildBirthDate,
    getDaysInMonth,
    getSelectableBirthYears,
} from "../birth-date-picker.js";
import { getCandidateAge } from "../candidate-age.js";

describe("getSelectableBirthYears", () => {
    it("covers every age the funnel can accept", () => {
        const today = new Date(2026, 8, 9);
        const years = getSelectableBirthYears(today);

        // 16 — наймолодший вік (Volkland 2), 28 — найстарший.
        expect(years[0]).toBe(2010);
        expect(years.at(-1)).toBe(1997);
    });

    it("lists years from the youngest down to the oldest", () => {
        const years = getSelectableBirthYears(new Date(2026, 8, 9));

        const sortedDescending = [...years].sort((a, b) => b - a);
        expect(years).toEqual(sortedDescending);
    });

    it("keeps the list short enough for one keyboard", () => {
        const years = getSelectableBirthYears(new Date(2026, 8, 9));

        expect(years.length).toBeLessThanOrEqual(15);
    });
});

describe("getDaysInMonth", () => {
    it("returns 29 days for February in a leap year", () => {
        expect(getDaysInMonth(2008, 2)).toBe(29);
    });

    it("returns 28 days for February in a common year", () => {
        expect(getDaysInMonth(2007, 2)).toBe(28);
    });

    it("distinguishes 30- and 31-day months", () => {
        expect(getDaysInMonth(2005, 4)).toBe(30);
        expect(getDaysInMonth(2005, 5)).toBe(31);
    });
});

describe("buildBirthDate", () => {
    it("builds the date at UTC midnight so day and month survive the read back", () => {
        const date = buildBirthDate(2005, 5, 15);

        // findBirthdaysToday сверяет getUTCDate/getUTCMonth. Дата, собранная в
        // локальном времени Киева (UTC+2/+3), читалась бы там как 14 мая, и
        // поздравление уходило бы на день раньше.
        expect(date?.getUTCDate()).toBe(15);
        expect(date?.getUTCMonth()).toBe(4);
        expect(date?.getUTCFullYear()).toBe(2005);
    });

    it("rejects a day that does not exist in the chosen month", () => {
        expect(buildBirthDate(2007, 2, 29)).toBeNull();
        expect(buildBirthDate(2005, 4, 31)).toBeNull();
    });

    it("accepts 29 February in a leap year", () => {
        expect(buildBirthDate(2008, 2, 29)).not.toBeNull();
    });

    it("returns null until every part has been chosen", () => {
        expect(buildBirthDate(undefined, 5, 15)).toBeNull();
        expect(buildBirthDate(2005, undefined, 15)).toBeNull();
        expect(buildBirthDate(2005, 5, undefined)).toBeNull();
    });

    it("rejects an out-of-range month", () => {
        expect(buildBirthDate(2005, 0, 15)).toBeNull();
        expect(buildBirthDate(2005, 13, 15)).toBeNull();
    });
});

describe("BIRTH_MONTH_LABELS", () => {
    it("lists twelve months in calendar order", () => {
        expect(BIRTH_MONTH_LABELS).toHaveLength(12);
        expect(BIRTH_MONTH_LABELS[0]).toBe("Січень");
        expect(BIRTH_MONTH_LABELS[11]).toBe("Грудень");
    });
});

describe("picker output feeds the age check", () => {
    it("produces a date the age helper reads back as the expected age", () => {
        const today = new Date();
        const year = today.getFullYear() - 20;
        const date = buildBirthDate(year, 1, 1);

        expect(date).not.toBeNull();
        // 1 января уже прошло к любой дате года, кроме самого 1 января, —
        // возраст либо ровно 20, либо 20 и в день рождения.
        expect(getCandidateAge(date!)).toBe(20);
    });
});
