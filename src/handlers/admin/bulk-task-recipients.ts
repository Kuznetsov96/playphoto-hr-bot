import type { StaffWithRelations } from "../../repositories/staff-repository.js";
import type { ShiftWithStaffAtLocation } from "../../repositories/work-shift-repository.js";

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
 * Разложить сотрудников со сменами по выбранным локациям — по локации САМОЙ СМЕНЫ, а не
 * по домашней локации сотрудника (`StaffProfile.locationId`), которая в этот день может
 * не совпадать с тем, где он реально работает.
 * Каждая выбранная локация присутствует в результате, даже если смен на ней нет —
 * администратор должен видеть, что туда задача не уйдёт.
 */
export function groupRecipientsByLocation(
    shifts: ShiftWithStaffAtLocation[],
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

    for (const shift of shifts) {
        if (alreadyPlaced.has(shift.staff.id)) continue;

        const target = byLocationId.get(shift.location.id);
        if (!target) continue;

        target.staff.push(shift.staff);
        alreadyPlaced.add(shift.staff.id);
    }

    return groups;
}
