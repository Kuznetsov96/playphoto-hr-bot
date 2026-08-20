import prisma from "../db/core.js";
import { logBusinessEvent } from "../core/log-events.js";
import { awsBusinessClient } from "./aws-business-client.js";
import {
    CanonicalScheduleReadError,
    projectCanonicalSchedule,
    type CanonicalScheduledShift
} from "./aws-schedule-canonical-projector.js";

export {
    CanonicalScheduleReadError,
    projectCanonicalSchedule,
    type CanonicalScheduledShift,
    type CanonicalScheduleReadReason
} from "./aws-schedule-canonical-projector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_WINDOW_DAYS = 62;
const USER_VISIBLE_READ_TIMEOUT_MS = 3_000;

export class AwsScheduleCanonicalReadService {
    async findForStaff(staffId: string, since: Date, limit: number): Promise<CanonicalScheduledShift[]> {
        const staff = await prisma.staffProfile.findUnique({
            where: { id: staffId },
            select: { awsEmployeePublicId: true }
        });
        if (!staff?.awsEmployeePublicId) {
            throw new CanonicalScheduleReadError("EMPLOYEE_NOT_MAPPED");
        }

        const { from, to } = scheduleWindow(since);
        const response = await awsBusinessClient.employeeSchedule(
            staff.awsEmployeePublicId,
            from,
            to,
            { timeoutMs: USER_VISIBLE_READ_TIMEOUT_MS }
        );
        const canonicalShifts = response.shifts.slice(0, limit);
        const locationPublicIds = [...new Set(canonicalShifts.map(shift => shift.locationPublicId))];
        const shiftPublicIds = canonicalShifts.map(shift => shift.publicId);
        const [locations, projections] = await Promise.all([
            locationPublicIds.length === 0
                ? Promise.resolve([])
                : prisma.location.findMany({
                    where: { awsPublicId: { in: locationPublicIds } },
                    select: {
                        id: true,
                        awsPublicId: true,
                        name: true,
                        city: true,
                        branch: true,
                        schedule: true,
                        openingHours: { orderBy: { dayOfWeek: "asc" }, select: { dayOfWeek: true, opens: true, closes: true } }
                    }
                }),
            shiftPublicIds.length === 0
                ? Promise.resolve([])
                : prisma.workShift.findMany({
                    where: { awsScheduledShiftPublicId: { in: shiftPublicIds } },
                    select: { id: true, awsScheduledShiftPublicId: true }
                })
        ]);

        const projected = projectCanonicalSchedule(staffId, canonicalShifts, locations, projections);

        // Пропуск незмаплених змін мовчазний за задумом — фотографині показується
        // решта канону, а не старе дзеркало цілком. Але мовчазний для неї, не для
        // нас: якщо синк дзеркала стане, зміни зникали б з екранів без жодного
        // сигналу. Один рядок на читання означає звичайне відставання; потік —
        // що дзеркало перестало наздоганяти.
        if (projected.length !== canonicalShifts.length) {
            logBusinessEvent({
                event: "bot.aws_schedule_canonical_read.shift_not_mirrored",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "partial",
                reasonCode: "SHIFT_PROJECTION_NOT_MAPPED",
                module: "aws-schedule-canonical-read",
                operation: "read",
                safeContext: {
                    canonicalCount: canonicalShifts.length,
                    projectedCount: projected.length,
                    skipped: canonicalShifts.length - projected.length
                }
            });
        }

        return projected;
    }
}

function scheduleWindow(since: Date) {
    const from = localDate(since, "Europe/Kyiv");
    const to = addDays(from, MAX_SCHEDULE_WINDOW_DAYS - 1);
    return { from, to };
}

function localDate(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function addDays(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export const awsScheduleCanonicalReadService = new AwsScheduleCanonicalReadService();
