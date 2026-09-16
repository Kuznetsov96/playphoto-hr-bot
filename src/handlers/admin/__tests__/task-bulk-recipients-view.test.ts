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
    it("is false when staff plus location headers exactly fill the cap", () => {
        const atCap = [groupWithStaffCount("loc-a", MAX_RECIPIENT_ROWS - 1)];
        expect(exceedsRecipientRowLimit(atCap)).toBe(false);
    });

    it("is true one row past the cap", () => {
        const overCap = [groupWithStaffCount("loc-a", MAX_RECIPIENT_ROWS)];
        expect(exceedsRecipientRowLimit(overCap)).toBe(true);
    });

    it("sums staff across multiple location groups", () => {
        const groupsAcrossLocations = [
            groupWithStaffCount("loc-a", Math.ceil(MAX_RECIPIENT_ROWS / 2)),
            groupWithStaffCount("loc-b", Math.ceil(MAX_RECIPIENT_ROWS / 2)),
        ];
        expect(exceedsRecipientRowLimit(groupsAcrossLocations)).toBe(true);
    });

    it("counts the header row every location adds, so many small locations still trip the cap", () => {
        // 70 человек, разбросанные по 20 локациям, — это 90 строк, а не 70.
        const staffPerLocation = 70 / 20;
        const manySmallLocations = Array.from({ length: 20 }, (_, i) =>
            groupWithStaffCount(`loc-${i}`, Math.ceil(staffPerLocation)),
        );
        const totalStaff = manySmallLocations.reduce((sum, g) => sum + g.staff.length, 0);

        expect(totalStaff).toBeLessThanOrEqual(MAX_RECIPIENT_ROWS);
        expect(exceedsRecipientRowLimit(manySmallLocations)).toBe(true);
    });

    it("counts headers of empty locations too, since they are still rendered", () => {
        const withEmptyLocations = [
            groupWithStaffCount("loc-a", MAX_RECIPIENT_ROWS - 3),
            groupWithStaffCount("loc-b", 0),
            groupWithStaffCount("loc-c", 0),
            groupWithStaffCount("loc-d", 0),
        ];
        // 77 человек уместились бы, но 4 заголовка пустых локаций перебирают бюджет.
        expect(exceedsRecipientRowLimit(withEmptyLocations)).toBe(true);
    });
});
