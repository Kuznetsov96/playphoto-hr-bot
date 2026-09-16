import { describe, expect, it } from "vitest";
import { buildConfirmationSummary } from "../task-bulk.js";
import type { BulkTaskLocationGroup } from "../bulk-task-recipients.js";

const groups: BulkTaskLocationGroup[] = [
    { locationId: "loc-a", city: "Kyiv", locationName: "Podil", staff: [{ id: "s1" }, { id: "s2" }] as any },
    { locationId: "loc-b", city: "Lviv", locationName: "Center", staff: [{ id: "s3" }] as any },
    { locationId: "loc-c", city: "Lviv", locationName: "Airport", staff: [] as any },
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

        expect(summary).toContain("Kyiv · Podil: 2");
        expect(summary).toContain("Lviv · Center: 1");
    });

    it("omits locations where nobody is selected", () => {
        const summary = buildConfirmationSummary(groups, [], params);

        expect(summary).not.toContain("Airport");
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
});
