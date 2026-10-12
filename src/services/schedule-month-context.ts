import prisma from "../db/core.js";
import { formatLocation } from "../utils/location-label.js";
import type { ScheduleMessageShift } from "../utils/format-schedule-message.js";
import { awsBusinessClient, type AwsEmployeeSchedule } from "./aws-business-client.js";

const READ_TIMEOUT_MS = 5_000;

/** Одна зміна людини в місяці — як її показати і як знайти серед подій. */
export type MonthShift = {
    /** `локація|дата|початок` — той самий ключ будується зі знімка події. */
    key: string;
    locationKey: string;
    shift: ScheduleMessageShift;
};

/** `YYYY-MM` -> усі заплановані зміни людини в цьому місяці. */
export type MonthContext = Map<string, MonthShift[]>;

type ScheduleLocation = { awsPublicId: string | null; name: string; city: string | null; branch: string | null };

export function shiftKey(locationPublicId: string, localDate: string, startsAt: string): string {
    return `${locationPublicId}|${localDate}|${startsAt}`;
}

/**
 * `2026-10` -> `{ from: 2026-10-01, to: 2026-10-31 }`; з `today` початок не
 * раніше сьогодні — минулих днів немає і в «Мій графік». Null — місяць минув.
 */
export function monthWindow(month: string, today?: string): { from: string; to: string } | null {
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const first = `${month}-01`;
    const to = `${month}-${String(lastDay).padStart(2, "0")}`;
    const from = today !== undefined && today > first ? today : first;
    return from > to ? null : { from, to };
}

/** Миттєвість -> `14:00` за київським часом: усі локації мережі в Україні. */
function kyivClock(instant: string): string {
    return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "Europe/Kyiv",
    }).format(new Date(instant));
}

/**
 * Pure: the canonical schedule of one month plus the bot's location catalogue
 * become rows in the same shape as an event snapshot, so an event can be found
 * in the list by key. A location missing from the catalogue throws — a shift
 * shown without where to go is worse than falling back to the event-only text.
 */
export function toMonthShifts(
    shifts: AwsEmployeeSchedule["shifts"],
    locations: ScheduleLocation[]
): MonthShift[] {
    const byPublicId = new Map(locations.flatMap(location =>
        location.awsPublicId ? [[location.awsPublicId, location] as const] : []
    ));
    return shifts.map(shift => {
        const location = byPublicId.get(shift.locationPublicId);
        if (!location) throw new Error("SCHEDULE_LOCATION_NOT_MAPPED");
        const startsAtLocal = kyivClock(shift.startsAt);
        return {
            key: shiftKey(shift.locationPublicId, shift.localDate, startsAtLocal),
            locationKey: shift.locationPublicId,
            shift: {
                localDate: shift.localDate,
                locationLabel: formatLocation(
                    { name: location.name, branch: location.branch, city: location.city ?? "" },
                    "listing"
                ),
                startsAtLocal,
                endsAtLocal: kyivClock(shift.endsAt),
            },
        };
    });
}

/**
 * The person's whole current month, read from the webapp at send time — the
 * same source as «Мій графік», so the message and the screen cannot disagree.
 * Throws on any failure; the caller falls back to the event-only text.
 */
export async function loadMonthContext(
    employeePublicId: string,
    months: string[],
    /** Київське «сьогодні»: минулі дні не рахуються, як і в «Мій графік». */
    today: string
): Promise<MonthContext> {
    const schedules = await Promise.all(months.map(async month => {
        const window = monthWindow(month, today);
        // Місяць, що вже минув, — порожній: запит із from > to вебапп відхилив би.
        if (window === null) return [month, [] as AwsEmployeeSchedule["shifts"]] as const;
        const { from, to } = window;
        const schedule = await awsBusinessClient.employeeSchedule(employeePublicId, from, to, {
            timeoutMs: READ_TIMEOUT_MS,
        });
        return [month, schedule.shifts] as const;
    }));

    const locationPublicIds = [...new Set(schedules.flatMap(([, shifts]) => shifts.map(shift => shift.locationPublicId)))];
    const locations = locationPublicIds.length === 0
        ? []
        : await prisma.location.findMany({
            where: { awsPublicId: { in: locationPublicIds } },
            select: { awsPublicId: true, name: true, city: true, branch: true },
        });

    return new Map(schedules.map(([month, shifts]) => [month, toMonthShifts(shifts, locations)]));
}
