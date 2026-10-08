import { getShiftTimeFromLocationSchedule } from "./shift-time.js";
import { getShiftTimeFromOpeningHours, type OpeningHoursDay } from "./location-opening-hours.js";

/** Час зміни для екранів співробітниці й картки теми підтримки — одне правило на обидва. */
export const SHIFT_TIME_NOT_SET = "час не вказано";

export function formatShiftClock(date: Date) {
    return date.toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Kyiv"
    });
}

/**
 * Shift times, most authoritative source first:
 *   1. the shift's own start/end, as planned in the webapp;
 *   2. the location's canonical opening hours for that weekday;
 *   3. the legacy hand-seeded text schedule, for locations not yet migrated.
 *
 * Never fall back to an invented default — an unknown time must read as "not set".
 */
export function formatStaffShiftTime(shift: {
    date: Date;
    startTime?: Date | null;
    endTime?: Date | null;
    location?: { schedule?: string | null; openingHours?: OpeningHoursDay[] | null } | null;
}) {
    if (shift.startTime && shift.endTime) {
        return `${formatShiftClock(shift.startTime)}-${formatShiftClock(shift.endTime)}`;
    }

    return getShiftTimeFromOpeningHours(shift.location?.openingHours, shift.date)
        || getShiftTimeFromLocationSchedule(shift.location?.schedule, shift.date)
        || SHIFT_TIME_NOT_SET;
}
