import { describe, expect, it } from "vitest";
import { groupRecipientsByLocation } from "../bulk-task-recipients.js";

const selected = [
    { id: "loc-a", city: "Kyiv", name: "Podil" },
    { id: "loc-b", city: "Kyiv", name: "Obolon" },
    { id: "loc-c", city: "Lviv", name: "Center" },
];

function shiftRow(staffId: string, shiftLocation: { id: string; city: string; name: string }, homeLocationId: string | null = null) {
    return {
        id: `shift-${staffId}-${shiftLocation.id}`,
        staffId,
        date: new Date("2026-09-20T10:00:00"),
        staff: {
            id: staffId,
            fullName: `Staff ${staffId}`,
            locationId: homeLocationId,
            user: { telegramId: BigInt(100) },
        },
        location: shiftLocation,
    } as any;
}

const locA = selected[0]!;
const locB = selected[1]!;
const locC = selected[2]!;

describe("groupRecipientsByLocation", () => {
    it("keeps every selected location, including ones with no shifts", () => {
        const groups = groupRecipientsByLocation([shiftRow("s1", locA)], selected);

        expect(groups.map(g => g.locationId)).toEqual(["loc-a", "loc-b", "loc-c"]);
        expect(groups[1]!.staff).toEqual([]);
        expect(groups[2]!.staff).toEqual([]);
    });

    it("preserves the caller's location order and labels", () => {
        const groups = groupRecipientsByLocation([], selected);

        expect(groups[2]).toEqual(expect.objectContaining({
            locationId: "loc-c",
            city: "Lviv",
            locationName: "Center",
        }));
    });

    it("places each staff member under the location of their shift", () => {
        const groups = groupRecipientsByLocation(
            [shiftRow("s1", locA), shiftRow("s2", locC), shiftRow("s3", locA)],
            selected,
        );

        expect(groups[0]!.staff.map(s => s.id)).toEqual(["s1", "s3"]);
        expect(groups[2]!.staff.map(s => s.id)).toEqual(["s2"]);
    });

    it("lists a staff member only once even if they have shifts at several selected locations, keeping the first in caller order", () => {
        const duplicated = [shiftRow("s1", locA), shiftRow("s1", locB)];

        const groups = groupRecipientsByLocation(duplicated, selected);
        const allIds = groups.flatMap(g => g.staff.map(s => s.id));

        expect(allIds).toEqual(["s1"]);
        expect(groups[0]!.staff.map(s => s.id)).toEqual(["s1"]);
        expect(groups[1]!.staff).toEqual([]);
    });

    it("drops shifts whose location is not among the selected ones", () => {
        const groups = groupRecipientsByLocation(
            [shiftRow("s9", { id: "loc-zzz", city: "Odesa", name: "Somewhere" })],
            selected,
        );

        expect(groups.flatMap(g => g.staff)).toEqual([]);
    });

    it("groups a staff member under the SHIFT location, not their home location (the defect this feature must not repeat)", () => {
        // s1's home location is Obolon (loc-b), but today they are on shift at Podil (loc-a).
        // Only Podil is selected. They must show up there, not be dropped, and not be listed
        // under their home location.
        const groups = groupRecipientsByLocation(
            [shiftRow("s1", locA, "loc-b")],
            [locA],
        );

        expect(groups).toHaveLength(1);
        expect(groups[0]!.locationId).toBe("loc-a");
        expect(groups[0]!.staff.map(s => s.id)).toEqual(["s1"]);
    });
});
