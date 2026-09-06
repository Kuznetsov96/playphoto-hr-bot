import { describe, expect, it } from "vitest";
import { renderDailySummary, type DailySummaryView } from "../finance/daily-summary-message.js";

/**
 * Разряды разделяются НЕРАЗРЫВНЫМ пробелом, чтобы Telegram не переносил сумму
 * посреди числа. Обычный пробел в ожидании теста не совпал бы ни с чем.
 */
const NBSP = " ";

const BASE: DailySummaryView = {
    totals: { salesTotal: 285400, cashTotal: 180200, terminalTotal: 105200 },
    locations: [
        { publicId: "a", label: "Smile Park, Kyiv", salesTotal: 42300, cashTotal: 30000, terminalTotal: 12300 },
        { publicId: "b", label: "Dragon Park 2, Lviv", salesTotal: 38100, cashTotal: 20000, terminalTotal: 18100 }
    ],
    overdue: [],
    neverOpened: []
};

describe("renderDailySummary", () => {
    it("leads with the estate total before any per-location detail", () => {
        const text = renderDailySummary(BASE, "2026-09-06");
        const total = text.indexOf(`285${NBSP}400`);
        const firstLocation = text.indexOf("Smile Park");

        expect(total).toBeGreaterThan(-1);
        expect(total).toBeLessThan(firstLocation);
    });

    it("lists locations in the order given, without re-sorting", () => {
        const text = renderDailySummary(BASE, "2026-09-06");

        expect(text.indexOf("Smile Park")).toBeLessThan(text.indexOf("Dragon Park 2"));
    });

    it("omits both problem blocks when nothing is outstanding", () => {
        const text = renderDailySummary(BASE, "2026-09-06");

        expect(text).not.toContain("Still open");
        expect(text).not.toContain("Never opened");
    });

    it("renders overdue shifts under their own heading with a count", () => {
        const text = renderDailySummary(
            { ...BASE, overdue: [{ publicId: "c", label: "Fly Kids, Rivne", openedAt: "2026-09-06T07:15:00.000Z" }] },
            "2026-09-06"
        );

        expect(text).toContain("Still open (1)");
        expect(text).toContain("Fly Kids, Rivne");
    });

    it("renders never-opened shifts separately from overdue ones", () => {
        const text = renderDailySummary(
            {
                ...BASE,
                overdue: [{ publicId: "c", label: "Fly Kids, Rivne", openedAt: null }],
                neverOpened: [{ publicId: "d", label: "Volkland (Shevchyk), Zaporizhzhia" }]
            },
            "2026-09-06"
        );

        expect(text).toContain("Still open (1)");
        expect(text).toContain("Never opened (1)");
        expect(text.indexOf("Still open")).toBeLessThan(text.indexOf("Never opened"));
    });

    it("shows when an overdue till was opened, in Kyiv time", () => {
        const text = renderDailySummary(
            { ...BASE, overdue: [{ publicId: "c", label: "Fly Kids, Rivne", openedAt: "2026-09-06T07:15:00.000Z" }] },
            "2026-09-06"
        );

        // 07:15 UTC is 10:15 in Kyiv — the owner reads local time, never UTC.
        expect(text).toContain("10:15");
    });

    it("escapes HTML in a location name so a stray character cannot break the message", () => {
        const text = renderDailySummary(
            {
                ...BASE,
                locations: [
                    { publicId: "a", label: "Smile <Park> & Co", salesTotal: 100, cashTotal: 100, terminalTotal: 0 }
                ]
            },
            "2026-09-06"
        );

        expect(text).toContain("Smile &lt;Park&gt; &amp; Co");
        expect(text).not.toContain("<Park>");
    });

    it("states plainly that no location traded rather than printing a bare zero", () => {
        const text = renderDailySummary(
            { totals: { salesTotal: 0, cashTotal: 0, terminalTotal: 0 }, locations: [], overdue: [], neverOpened: [] },
            "2026-09-06"
        );

        expect(text).toContain("No sales recorded");
    });

    it("still reports the day when the summary could not be fetched", () => {
        const text = renderDailySummary(null, "2026-09-06");

        // Silence would read as "nothing happened"; the owner must know the report failed.
        expect(text).toContain("could not be loaded");
        expect(text).toContain("2026");
    });
});
