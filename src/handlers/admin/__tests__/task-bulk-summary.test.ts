import { describe, expect, it } from "vitest";
import { buildConfirmationSummary, TELEGRAM_MESSAGE_LIMIT } from "../task-bulk.js";
import type { BulkTaskLocationGroup } from "../bulk-task-recipients.js";

const groups: BulkTaskLocationGroup[] = [
    { locationId: "loc-a", city: "Kyiv", locationName: "Podil", label: "Podil (Kyiv)", staff: [{ id: "s1" }, { id: "s2" }] as any },
    { locationId: "loc-b", city: "Lviv", locationName: "Center", label: "Center (Lviv)", staff: [{ id: "s3" }] as any },
    { locationId: "loc-c", city: "Lviv", locationName: "Airport", label: "Airport (Lviv)", staff: [] as any },
];

const params = {
    date: "2026-09-20",
    deadlineTime: "23:59",
    completionMode: "PROOF_REQUIRED",
    taskText: "Check the printers",
};

describe("buildConfirmationSummary", () => {
    it("states how many people and how many locations will be hit", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary).toContain("3 staff");
        expect(summary).toContain("2 locations");
    });

    it("excludes unchecked staff from the totals", () => {
        const summary = buildConfirmationSummary(groups, ["s1", "s2"], params);

        expect(summary).toContain("1 staff");
        expect(summary).toContain("1 location");
    });

    it("breaks the count down per location", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary).toContain("Podil (Kyiv): 2");
        expect(summary).toContain("Center (Lviv): 1");
    });

    it("omits locations where nobody is selected", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary).not.toContain("Airport");
    });

    it("breaks down two same-named venues in different branches as distinguishable lines (the defect CI caught)", () => {
        // Zaporizhzhia alone has three venues called "Volkland". A breakdown built from
        // city + name would print "Zaporizhzhia · Volkland: N" for both, and an owner
        // could not tell which branch is which. The label carries `branch`, so the two
        // lines must read differently.
        const sameNameGroups: BulkTaskLocationGroup[] = [
            { locationId: "loc-volkland-1", city: "Zaporizhzhia", locationName: "Volkland", label: "Volkland (Шевчик)", staff: [{ id: "s1" }, { id: "s2" }] as any },
            { locationId: "loc-volkland-2", city: "Zaporizhzhia", locationName: "Volkland", label: "Volkland (Центр)", staff: [{ id: "s3" }] as any },
        ];

        const summary = buildConfirmationSummary(sameNameGroups, [], params);

        expect(summary).toContain("Volkland (Шевчик): 2");
        expect(summary).toContain("Volkland (Центр): 1");
    });

    it("shows the task text and the deadline", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary).toContain("Check the printers");
        expect(summary).toContain("23:59");
    });

    it("says there is no deadline when none was set", () => {
        const summary = buildConfirmationSummary(groups, [], { ...params, deadlineTime: null });

        expect(summary).toContain("No deadline");
    });

    it("stays under the Telegram message limit for a realistic single-location case", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
    });

    it("can exceed the Telegram message limit with many locations and a long task text", () => {
        // Reflects a realistic scenario: 20 locations with 55-char Ukrainian-style
        // labels, plus a task text at the TASK_TEXT_MAX_LENGTH ceiling (3000 chars,
        // which counts HTML markup, not just visible text).
        const manyGroups: BulkTaskLocationGroup[] = Array.from({ length: 20 }, (_, i) => ({
            locationId: `loc-${i}`,
            city: "Дніпропетровськ-Наддніпрянський",
            locationName: `Фотостудія на вулиці Соборній, корпус ${i + 1}`,
            label: `Фотостудія на вулиці Соборній, корпус ${i + 1} (Дніпропетровськ-Наддніпрянський)`,
            staff: [{ id: `s${i}` }] as any,
        }));
        const longText = "<b>" + "Перевірте принтери та камери. ".repeat(90).slice(0, 2990) + "</b>";

        const summary = buildConfirmationSummary(manyGroups, [], { ...params, taskText: longText });

        expect(summary.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
    });
});
