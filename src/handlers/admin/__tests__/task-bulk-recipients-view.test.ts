import { describe, expect, it } from "vitest";
import { buildRecipientRows, countSelectedRecipients, exceedsRecipientRowLimit, MAX_RECIPIENT_ROWS } from "../task-bulk.js";
import type { BulkTaskLocationGroup } from "../bulk-task-recipients.js";

function group(locationId: string, city: string, name: string, staff: { id: string; fullName: string }[]): BulkTaskLocationGroup {
    return { locationId, city, locationName: name, staff: staff as any };
}

function groupWithStaffCount(locationId: string, count: number): BulkTaskLocationGroup {
    const staff = Array.from({ length: count }, (_, i) => ({ id: `${locationId}-s${i}`, fullName: `Staff ${i}` }));
    return group(locationId, "Kyiv", locationId, staff);
}

const groups: BulkTaskLocationGroup[] = [
    group("loc-a", "Kyiv", "Podil", [{ id: "s1", fullName: "Шевченко Тарас" }, { id: "s2", fullName: "Леся Українка" }]),
    group("loc-b", "Kyiv", "Obolon", []),
];

describe("buildRecipientRows", () => {
    it("checks everyone by default", () => {
        const rows = buildRecipientRows(groups, []);
        const staffRows = rows.flat().filter(b => b.callback_data.startsWith("tbk_staff_"));

        expect(staffRows).toHaveLength(2);
        expect(staffRows.every(b => b.text.startsWith("✅"))).toBe(true);
    });

    it("unchecks only the excluded staff", () => {
        const rows = buildRecipientRows(groups, ["s1"]);
        const staffRows = rows.flat().filter(b => b.callback_data.startsWith("tbk_staff_"));

        expect(staffRows.find(b => b.callback_data === "tbk_staff_s1")!.text.startsWith("⬜")).toBe(true);
        expect(staffRows.find(b => b.callback_data === "tbk_staff_s2")!.text.startsWith("✅")).toBe(true);
    });

    it("shows a location header that cannot be clicked", () => {
        const rows = buildRecipientRows(groups, []);
        const header = rows.flat().find(b => b.text.includes("Podil"))!;

        expect(header.callback_data).toBe("tbk_noop");
    });

    it("marks a location that has no shifts on that date", () => {
        const rows = buildRecipientRows(groups, []);
        const obolon = rows.flat().find(b => b.text.includes("Obolon"))!;

        expect(obolon.text).toContain("no shifts");
        expect(obolon.callback_data).toBe("tbk_noop");
    });
});

describe("countSelectedRecipients", () => {
    it("counts everyone when nothing is excluded", () => {
        expect(countSelectedRecipients(groups, [])).toBe(2);
    });

    it("ignores excluded staff", () => {
        expect(countSelectedRecipients(groups, ["s1", "s2"])).toBe(0);
    });

    it("ignores exclusions that no longer match anyone on shift", () => {
        expect(countSelectedRecipients(groups, ["ghost"])).toBe(2);
    });
});

describe("exceedsRecipientRowLimit", () => {
    it("is false at or under the cap", () => {
        const atCap = [groupWithStaffCount("loc-a", MAX_RECIPIENT_ROWS)];
        expect(exceedsRecipientRowLimit(atCap)).toBe(false);
    });

    it("is true once total staff rows exceed the cap", () => {
        const overCap = [groupWithStaffCount("loc-a", MAX_RECIPIENT_ROWS + 1)];
        expect(exceedsRecipientRowLimit(overCap)).toBe(true);
    });

    it("sums staff across multiple location groups", () => {
        const groupsAcrossLocations = [
            groupWithStaffCount("loc-a", Math.ceil(MAX_RECIPIENT_ROWS / 2) + 1),
            groupWithStaffCount("loc-b", Math.ceil(MAX_RECIPIENT_ROWS / 2) + 1),
        ];
        expect(exceedsRecipientRowLimit(groupsAcrossLocations)).toBe(true);
    });
});
