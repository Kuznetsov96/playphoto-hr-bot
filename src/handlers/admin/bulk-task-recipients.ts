import type { StaffWithRelations } from "../../repositories/staff-repository.js";

export type BulkTaskLocationGroup = {
    locationId: string;
    city: string;
    locationName: string;
    staff: StaffWithRelations[];
};

export type SelectedLocation = {
    id: string;
    city: string;
    name: string;
};

/**
 * Разложить сотрудников со сменами по выбранным локациям.
 * Каждая выбранная локация присутствует в результате, даже если смен на ней нет —
 * администратор должен видеть, что туда задача не уйдёт.
 */
export function groupRecipientsByLocation(
    staff: StaffWithRelations[],
    selectedLocations: SelectedLocation[],
): BulkTaskLocationGroup[] {
    const groups: BulkTaskLocationGroup[] = selectedLocations.map(loc => ({
        locationId: loc.id,
        city: loc.city,
        locationName: loc.name,
        staff: [],
    }));

    const byLocationId = new Map(groups.map(g => [g.locationId, g]));
    const alreadyPlaced = new Set<string>();

    for (const member of staff) {
        if (alreadyPlaced.has(member.id)) continue;

        const target = member.locationId ? byLocationId.get(member.locationId) : undefined;
        if (!target) continue;

        target.staff.push(member);
        alreadyPlaced.add(member.id);
    }

    return groups;
}
