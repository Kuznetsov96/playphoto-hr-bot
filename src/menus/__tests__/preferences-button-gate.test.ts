import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../staff.ts", import.meta.url)), "utf8");

/**
 * The button used to be hidden on a Redis key written ONLY by the Google Sheets sync branch.
 * Production runs `BUSINESS_DATA_SOURCE=aws`, where `syncSchedule` returns before ever reaching
 * that write — so the button stayed in the menu after the schedule was published, offering an
 * action the backend would refuse.
 */
describe("preferences button gate", () => {
    it("asks the backend whether collection is still open", () => {
        expect(source).toContain("schedulePreferenceWindow");
    });

    it("keeps the Redis flag only for the Google Sheets deployment", () => {
        expect(source).toMatch(
            /BUSINESS_DATA_SOURCE !== "aws"[\s\S]{0,400}isSchedulePublishedForMonth/u
        );
    });

    /**
     * Failing closed would hide the button from someone who came to fill preferences in time.
     * Failing open at worst offers an action that gets a clear refusal on save.
     */
    it("keeps the button when the backend cannot be reached", () => {
        expect(source).toMatch(/catch[\s\S]{0,300}return true;/u);
    });

    /** The menu renders on every tap and the gate runs twice per render. */
    it("caches the answer so a tap does not cost two API calls", () => {
        expect(source).toContain("WINDOW_CACHE_TTL_MS");
        expect(source).toMatch(/windowCache\s*=\s*\{/u);
    });

    it("still hides the button before the 23rd", () => {
        expect(source).toMatch(/getDate\(\) < 23\) return false/u);
    });
});

/**
 * Placement and label. A few days a month this is the most urgent thing a photographer has —
 * it has a deadline and the bot chases it every six hours — while everything else in the hub is
 * available all the time. It used to sit third, below "Потрібна заміна".
 */
describe("preferences button presentation", () => {
    it("leads the hub while collection is open", () => {
        const preferences = source.indexOf("Побажання (${monthName})");
        const schedule = source.indexOf('range.text("🗓 Мій графік"');
        const replacement = source.indexOf('range.text("🔁 Шукати підміну"');

        expect(preferences).toBeGreaterThan(-1);
        expect(preferences).toBeLessThan(schedule);
        expect(preferences).toBeLessThan(replacement);
    });

    /** Two calendars in a row forced reading the labels to tell them apart. */
    it("does not reuse the calendar icon that already marks Мій графік", () => {
        expect(source).toContain("📝 Побажання");
        expect(source).not.toContain("🗓 Побажання");
    });

    /** 20–23 characters depending on the month — it would be clipped beside a neighbour. */
    it("takes a full-width row of its own", () => {
        expect(source).toMatch(/📝 Побажання[\s\S]{0,500}\}\)\.row\(\);/u);
    });
});
