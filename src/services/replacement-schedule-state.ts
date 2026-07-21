const KYIV_TIME_ZONE = "Europe/Kyiv";

export type ScheduledShiftIdentity = {
    id?: string;
    staffId: string;
    locationId: string;
    date: Date;
};

export type AcceptedReplacementIdentity = {
    requesterStaffId: string | null;
    replacementStaffId: string | null;
    locationId: string;
    shiftDate: Date;
};

export type AcceptedReplacementScheduleState = "pending" | "scheduled" | "superseded";

export function getScheduleDateKey(date: Date) {
    return date.toLocaleDateString("en-CA", { timeZone: KYIV_TIME_ZONE });
}

export function getScheduleSlotKey(locationId: string, date: Date) {
    return `${locationId}:${getScheduleDateKey(date)}`;
}

/**
 * Classifies an accepted replacement against the authoritative main schedule.
 *
 * - scheduled: the accepted photographer is already present at this slot;
 * - pending: the old owner is still present (or the slot is still empty), so the
 *   accepted assignment remains the effective source until an admin syncs it;
 * - superseded: the accepted photographer is absent and the schedule now points
 *   at another assignment, so the old acceptance must no longer be displayed.
 */
export function classifyAcceptedReplacement(
    assignment: AcceptedReplacementIdentity,
    scheduledShifts: ScheduledShiftIdentity[]
): AcceptedReplacementScheduleState {
    const assignmentDateKey = getScheduleDateKey(assignment.shiftDate);
    const sameDayShifts = scheduledShifts.filter(
        shift => getScheduleDateKey(shift.date) === assignmentDateKey
    );

    const replacementShifts = assignment.replacementStaffId
        ? sameDayShifts.filter(shift => shift.staffId === assignment.replacementStaffId)
        : [];

    if (replacementShifts.some(shift => shift.locationId === assignment.locationId)) {
        return "scheduled";
    }

    // A different same-day shift for the accepted photographer is authoritative
    // and also prevents showing two conflicting assignments for that day.
    if (replacementShifts.length > 0) return "superseded";

    const slotShifts = sameDayShifts.filter(shift => shift.locationId === assignment.locationId);
    if (slotShifts.length === 0) return "pending";

    if (
        assignment.requesterStaffId
        && slotShifts.some(shift => shift.staffId === assignment.requesterStaffId)
    ) {
        return "pending";
    }

    return "superseded";
}
