import { getVisibleStaffShifts, type StaffShiftView } from "./staff-schedule-view.js";

/**
 * Enough rows to see past a same-day replacement without paging the whole
 * schedule: the canonical read returns them date-ascending, so today's is at the
 * front, and a handful of neighbours covers the accepted-replacement snapshots
 * that share the date.
 */
const TODAY_LOOKUP_LIMIT = 5;

/**
 * The photographer's shift for `kyivToday`, or null if she is not working.
 *
 * Every screen that asks "does she have a shift today" goes through here so they
 * all answer from one source. Four of them used to read the local mirror while
 * the schedule screen read canonically — the two can disagree for as long as a
 * sync cycle, which is a photographer seeing a shift on the hub and none on her
 * schedule, or being shown parcels for a location she is not at.
 *
 * A shift whose replacement has already been accepted is not returned: it is no
 * longer hers to act on, and the schedule screen already hides it. One that is
 * still searching for a replacement stays — nobody has taken it yet, so she is
 * still expected to work it.
 */
export async function getStaffShiftToday(
    staffId: string,
    kyivToday: Date,
): Promise<StaffShiftView | null> {
    const shifts = await getVisibleStaffShifts(staffId, kyivToday, TODAY_LOOKUP_LIMIT, {
        canonicalRead: true,
    });

    return (
        shifts.find(
            (shift) =>
                shift.date.getTime() === kyivToday.getTime() &&
                !shift.isAcceptedReplacementPendingSync,
        ) ?? null
    );
}
