import { describe, expect, it } from "vitest";

import {
    buildJobDetailsText,
    formatGuaranteeLine,
    formatHryvnias,
    formatOpeningHours,
    formatPayLine,
    formatPercent,
    readLocationPay,
} from "../job-details.js";

/**
 * Блок «Твоя робота» зі знімка вебаппа (рішення власника 01.10.2026,
 * варіант A): рядок без даних не виводиться, години групуються, оплата —
 * без зайвих нулів і з «щодня», коли будні й вихідні однакові.
 */
const day = (dayOfWeek: number, opens: string, closes: string) => ({ dayOfWeek, opens, closes });

const pay = (overrides: Partial<Record<string, number>> = {}) => ({
    weekdayPercent: 25,
    weekendPercent: 30,
    weekdayPairPercent: 0,
    weekendPairPercent: 0,
    weekdayGuarantee: 500,
    weekendGuarantee: 700,
    ...overrides,
});

describe("formatOpeningHours", () => {
    it("groups consecutive days with equal hours", () => {
        const week = [1, 2, 3, 4, 5].map((d) => day(d, "10:00", "21:00"))
            .concat([6, 7].map((d) => day(d, "10:00", "22:00")));

        expect(formatOpeningHours(week)).toBe("Пн–Пт 10:00–21:00, Сб–Нд 10:00–22:00");
    });

    it("collapses the whole week into one range", () => {
        expect(formatOpeningHours([1, 2, 3, 4, 5, 6, 7].map((d) => day(d, "10:00", "21:00"))))
            .toBe("Пн–Нд 10:00–21:00");
    });

    it("names a lone day without a range", () => {
        const week = [
            day(1, "10:00", "21:00"), day(2, "10:00", "21:00"),
            day(3, "12:00", "20:00"),
            day(4, "10:00", "21:00"), day(5, "10:00", "21:00"),
        ];

        expect(formatOpeningHours(week)).toBe("Пн–Вт 10:00–21:00, Ср 12:00–20:00, Чт–Пт 10:00–21:00");
    });

    it("never mentions a closed day and does not bridge a range over it", () => {
        const week = [1, 2, 4, 5].map((d) => day(d, "10:00", "21:00"));

        expect(formatOpeningHours(week)).toBe("Пн–Вт 10:00–21:00, Чт–Пт 10:00–21:00");
    });

    it("sorts unordered input", () => {
        expect(formatOpeningHours([day(7, "10:00", "22:00"), day(6, "10:00", "22:00")]))
            .toBe("Сб–Нд 10:00–22:00");
    });

    it("returns null when no hours are recorded", () => {
        expect(formatOpeningHours([])).toBeNull();
        expect(formatOpeningHours(null)).toBeNull();
        expect(formatOpeningHours(undefined)).toBeNull();
    });
});

describe("number formatting", () => {
    it("drops trailing zeros from percents", () => {
        expect(formatPercent(25)).toBe("25");
        expect(formatPercent(22.5)).toBe("22.5");
        expect(formatPercent(22.50)).toBe("22.5");
    });

    it("prints hryvnias as integers with a thousands space", () => {
        expect(formatHryvnias(500)).toBe("500");
        expect(formatHryvnias(1000)).toBe("1 000");
        expect(formatHryvnias(1250.4)).toBe("1 250");
        expect(formatHryvnias(12500)).toBe("12 500");
    });
});

describe("formatPayLine", () => {
    it("weekday and weekend percents without a pair", () => {
        expect(formatPayLine(pay())).toBe("25 % від виручки в будні, 30 % у вихідні");
    });

    it("says «щодня» when weekday and weekend match", () => {
        expect(formatPayLine(pay({ weekendPercent: 25 }))).toBe("25 % від виручки щодня");
    });

    it("adds the pair percent only when it is set", () => {
        expect(formatPayLine(pay({ weekdayPairPercent: 18, weekendPairPercent: 18 })))
            .toBe("25 % від виручки в будні, 30 % у вихідні; удвох — 18 %");
    });

    it("splits the pair percent when weekday and weekend differ", () => {
        expect(formatPayLine(pay({ weekdayPairPercent: 18, weekendPairPercent: 20 })))
            .toBe("25 % від виручки в будні, 30 % у вихідні; удвох — 18 % у будні, 20 % у вихідні");
    });

    it("names the side of the week when the pair is set on one side only", () => {
        expect(formatPayLine(pay({ weekendPairPercent: 20 })))
            .toBe("25 % від виручки в будні, 30 % у вихідні; удвох — 20 % у вихідні");
        expect(formatPayLine(pay({ weekdayPairPercent: 18 })))
            .toBe("25 % від виручки в будні, 30 % у вихідні; удвох — 18 % у будні");
    });

    it("keeps fractional percents without trailing zeros", () => {
        expect(formatPayLine(pay({ weekdayPercent: 22.5, weekendPercent: 22.5 }))).toBe("22.5 % від виручки щодня");
    });

    it("returns null without pay terms", () => {
        expect(formatPayLine(null)).toBeNull();
        expect(formatPayLine(pay({ weekdayPercent: 0, weekendPercent: 0 }))).toBeNull();
    });
});

describe("formatGuaranteeLine", () => {
    it("weekday and weekend guarantees", () => {
        expect(formatGuaranteeLine(pay({ weekdayGuarantee: 500, weekendGuarantee: 1000 })))
            .toBe("500 грн у будні, 1 000 грн у вихідні");
    });

    it("says «щодня» when both match", () => {
        expect(formatGuaranteeLine(pay({ weekdayGuarantee: 500, weekendGuarantee: 500 }))).toBe("500 грн щодня");
    });

    it("returns null without a guarantee", () => {
        expect(formatGuaranteeLine(pay({ weekdayGuarantee: 0, weekendGuarantee: 0 }))).toBeNull();
        expect(formatGuaranteeLine(null)).toBeNull();
    });
});

describe("readLocationPay", () => {
    it("accepts a complete record", () => {
        expect(readLocationPay(pay())).toEqual(pay());
    });

    it("treats an incomplete or foreign Json value as absent", () => {
        expect(readLocationPay({ weekdayPercent: 25 })).toBeNull();
        expect(readLocationPay("25%")).toBeNull();
        expect(readLocationPay(null)).toBeNull();
    });
});

describe("buildJobDetailsText", () => {
    const location = { name: "Leoland", city: "Львів", branch: null };

    it("renders the full variant-A block", () => {
        const text = buildJobDetailsText({
            ...location,
            address: "Львів, вул. Мельника 18",
            openingHours: [1, 2, 3, 4, 5].map((d) => day(d, "10:00", "21:00"))
                .concat([6, 7].map((d) => day(d, "10:00", "22:00"))),
            pay: pay({ weekdayPairPercent: 18, weekendPairPercent: 18, weekdayGuarantee: 500, weekendGuarantee: 500 }),
        });

        expect(text).toBe(
            "<b>Leoland (Lviv)</b>\n" +
            "Адреса: Львів, вул. Мельника 18\n" +
            "Години роботи: Пн–Пт 10:00–21:00, Сб–Нд 10:00–22:00\n" +
            "Оплата: 25 % від виручки в будні, 30 % у вихідні; удвох — 18 %\n" +
            "Гарантія за зміну: 500 грн щодня",
        );
    });

    it("omits every line that has no data", () => {
        expect(buildJobDetailsText({ ...location, address: null, openingHours: [], pay: pay({ weekdayGuarantee: 0, weekendGuarantee: 0 }) }))
            .toBe("<b>Leoland (Lviv)</b>\nОплата: 25 % від виручки в будні, 30 % у вихідні");
    });

    it("returns null when there is nothing to show — no invented defaults", () => {
        expect(buildJobDetailsText({ ...location, address: "  ", openingHours: [], pay: null })).toBeNull();
        expect(buildJobDetailsText(null)).toBeNull();
    });

    it("escapes HTML in the address", () => {
        expect(buildJobDetailsText({ ...location, address: "ТЦ <Прут> & Co" }))
            .toContain("Адреса: ТЦ &lt;Прут&gt; &amp; Co");
    });
});
