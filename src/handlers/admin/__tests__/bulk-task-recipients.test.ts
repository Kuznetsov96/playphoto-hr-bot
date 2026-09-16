import { describe, expect, it } from "vitest";
import { groupRecipientsByLocation } from "../bulk-task-recipients.js";

const selected = [
    { id: "loc-a", city: "Kyiv", name: "Podil" },
    { id: "loc-b", city: "Kyiv", name: "Obolon" },
    { id: "loc-c", city: "Lviv", name: "Center" },
];

function staffRow(id: string, locationId: string | null) {
    return {
        id,
        fullName: `Staff ${id}`,
        locationId,
        user: { telegramId: BigInt(100) },
        location: locationId ? { id: locationId, city: "Kyiv", name: "Podil" } : null,
    } as any;
}

describe("groupRecipientsByLocation", () => {
    it("keeps every selected location, including ones with no shifts", () => {
        const groups = groupRecipientsByLocation([staffRow("s1", "loc-a")], selected);

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

    it("places each staff member under their own location", () => {
        const groups = groupRecipientsByLocation(
            [staffRow("s1", "loc-a"), staffRow("s2", "loc-c"), staffRow("s3", "loc-a")],
            selected,
        );

        expect(groups[0]!.staff.map(s => s.id)).toEqual(["s1", "s3"]);
        expect(groups[2]!.staff.map(s => s.id)).toEqual(["s2"]);
    });

    it("lists a staff member only once even if they match several selected locations", () => {
        const duplicated = [staffRow("s1", "loc-a"), staffRow("s1", "loc-b")];

        const groups = groupRecipientsByLocation(duplicated, selected);
        const allIds = groups.flatMap(g => g.staff.map(s => s.id));

        expect(allIds).toEqual(["s1"]);
    });

    it("drops staff whose location is not among the selected ones", () => {
        const groups = groupRecipientsByLocation([staffRow("s9", "loc-zzz")], selected);

        expect(groups.flatMap(g => g.staff)).toEqual([]);
    });
});
