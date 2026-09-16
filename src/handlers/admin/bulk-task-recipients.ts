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
 *
 * Сотрудник, у которого в этот день смены на нескольких выбранных локациях, попадает
 * только в ПЕРВУЮ по порядку `selectedLocations` — он получит одну задачу, а в списке
 * получателей остальных таких локаций его не будет.
 *
 * Порядок при выборе "первой" локации определяется исключительно порядком
 * `selectedLocations`, а не порядком строк `shifts` — Postgres без `ORDER BY` не
 * гарантирует стабильный порядок строк, поэтому решение не должно зависеть от него.
 */
export function groupRecipientsByLocation(
    shifts: ShiftWithStaffAtLocation[],
    selectedLocations: SelectedLocation[],
): BulkTaskLocationGroup[] {
    const shiftsByLocationId = new Map<string, ShiftWithStaffAtLocation[]>();
    for (const shift of shifts) {
        const bucket = shiftsByLocationId.get(shift.location.id);
        if (bucket) {
            bucket.push(shift);
        } else {
            shiftsByLocationId.set(shift.location.id, [shift]);
        }
    }

    const alreadyPlaced = new Set<string>();

    return selectedLocations.map(loc => {
        const candidates = shiftsByLocationId.get(loc.id) ?? [];
        const staff: StaffWithRelations[] = [];

        for (const shift of candidates) {
            if (alreadyPlaced.has(shift.staff.id)) continue;
            staff.push(shift.staff);
            alreadyPlaced.add(shift.staff.id);
        }

        return {
            locationId: loc.id,
            city: loc.city,
            locationName: loc.name,
            staff,
        };
    });
}
