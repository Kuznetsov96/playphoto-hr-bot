import { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { taskService } from "./task-service.js";
import logger from "../core/logger.js";
import prisma from "../db/core.js";
import { logBusinessEvent } from "../core/log-events.js";
import { AWS_REMINDERS_CANONICAL_READ_ENABLED } from "../config.js";
import { awsScheduleCanonicalReadService } from "./aws-schedule-canonical-read.js";
import { replacementService } from "./replacement-service.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { redis } from "../core/redis.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import {
    classifyAcceptedReplacement,
    getScheduleSlotKey
} from "./replacement-schedule-state.js";

const KYIV_TIME_ZONE = "Europe/Kyiv";

const kyivDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: KYIV_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
});

function getKyivDateParts(date: Date) {
    const values = kyivDateTimeFormatter.formatToParts(date).reduce<Record<string, string>>((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
    }, {});

    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour),
        minute: Number(values.minute),
        second: Number(values.second)
    };
}

function getKyivUtcOffsetMinutes(date: Date) {
    const parts = getKyivDateParts(date);
    const kyivRenderedAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second
    );
    return (kyivRenderedAsUtc - date.getTime()) / 60000;
}

function createKyivDateTime(year: number, month: number, day: number, hour: number, minute: number = 0) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const roughDate = new Date(utcGuess);
    const firstPass = new Date(utcGuess - getKyivUtcOffsetMinutes(roughDate) * 60_000);
    return new Date(utcGuess - getKyivUtcOffsetMinutes(firstPass) * 60_000);
}

function getKyivCalendarDateRange(now: Date) {
    const parts = getKyivDateParts(now);
    const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function getNextShiftReminderAt(now: Date) {
    const parts = getKyivDateParts(now);
    let nextRun = createKyivDateTime(parts.year, parts.month, parts.day, 8);

    if (nextRun <= now) {
        const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
        nextRun = createKyivDateTime(
            tomorrow.getUTCFullYear(),
            tomorrow.getUTCMonth() + 1,
            tomorrow.getUTCDate(),
            8
        );
    }

    return nextRun;
}

export async function sendDailyShiftReminders(bot: Bot<MyContext>) {
    const now = new Date();
    const { start: startOfDay, end: endOfDay } = getKyivCalendarDateRange(now);

    try {
        const readLegacyShifts = () =>
            workShiftRepository.findWithRelationsByDateRange(startOfDay, endOfDay);

        const readShifts = async () => {
            if (!AWS_REMINDERS_CANONICAL_READ_ENABLED) return readLegacyShifts();

            const startedAt = Date.now();
            try {
                const activeStaffCount = await prisma.staffProfile.count({ where: { isActive: true } });
                const staff = await prisma.staffProfile.findMany({
                    where: { isActive: true, awsEmployeePublicId: { not: null } },
                    include: { user: true }
                });

                // The canonical query narrows to mapped staff only; an active
                // photographer without a canonical mapping would otherwise
                // silently lose their 08:00 reminder with nothing thrown to
                // trigger the legacy fallback below. Make the gap observable,
                // and if it swallows everyone, treat that as a failure rather
                // than deliver nothing.
                const unmappedActiveStaffCount = activeStaffCount - staff.length;
                if (activeStaffCount > 0 && staff.length === 0) {
                    throw new Error("Canonical reminder read excluded all active staff for lack of a mapping");
                }
                if (unmappedActiveStaffCount > 0) {
                    logBusinessEvent({
                        event: "bot.reminders_canonical_read.unmapped_staff",
                        level: "warn",
                        actorType: "system",
                        actorRole: "system",
                        result: "success",
                        reasonCode: "STAFF_NOT_CANONICALLY_MAPPED",
                        module: "shift-reminder",
                        operation: "read",
                        safeContext: {
                            activeStaffCount,
                            mappedStaffCount: staff.length,
                            unmappedActiveStaffCount
                        }
                    });
                }

                const staffById = new Map(staff.map(profile => [profile.id, profile]));
                const perStaff = await Promise.all(
                    staff.map(profile =>
                        awsScheduleCanonicalReadService.findForStaff(profile.id, startOfDay, 5)
                    )
                );

                // The canonical projection carries no staff relation, but the
                // delivery loop below reads shift.staff.user.telegramId and
                // shift.staff.fullName. Attach the profile here so both paths
                // hand the loop the identical shape.
                const shifts = perStaff
                    .flat()
                    .filter(shift => shift.date >= startOfDay && shift.date < endOfDay)
                    .flatMap(shift => {
                        const profile = staffById.get(shift.staffId);
                        return profile ? [{ ...shift, staff: profile }] : [];
                    });

                logBusinessEvent({
                    event: "bot.reminders_canonical_read.succeeded",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "shift-reminder",
                    operation: "read",
                    durationMs: Date.now() - startedAt,
                    safeContext: { staffCount: staff.length, shiftCount: shifts.length }
                });

                return shifts;
            } catch (error: unknown) {
                const shifts = await readLegacyShifts();

                logBusinessEvent({
                    event: "bot.reminders_canonical_read.fallback",
                    level: "warn",
                    actorType: "system",
                    actorRole: "system",
                    result: "fallback",
                    reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE",
                    module: "shift-reminder",
                    operation: "read",
                    durationMs: Date.now() - startedAt,
                    safeContext: {
                        errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                        legacyShiftCount: shifts.length
                    }
                });

                return shifts;
            }
        };

        const [scheduledShifts, acceptedAssignments] = await Promise.all([
            readShifts(),
            replacementService.listAcceptedAssignmentsByDateRange(startOfDay, endOfDay)
        ]);

        const coveredStaffIds = new Set(scheduledShifts.map(shift => shift.staffId));
        const replacedScheduledShiftKeys = new Set<string>();
        const acceptedPendingSync = acceptedAssignments
            .filter(assignment => {
                if (!assignment.replacement || coveredStaffIds.has(assignment.replacement.id)) return false;

                const scheduleState = classifyAcceptedReplacement({
                    requesterStaffId: assignment.requesterStaffId,
                    replacementStaffId: assignment.replacementStaffId,
                    locationId: assignment.locationId,
                    shiftDate: assignment.shiftDate
                }, scheduledShifts);
                if (scheduleState !== "pending") return false;

                if (assignment.requesterStaffId) {
                    replacedScheduledShiftKeys.add(
                        `${assignment.requesterStaffId}:${getScheduleSlotKey(assignment.locationId, assignment.shiftDate)}`
                    );
                }
                coveredStaffIds.add(assignment.replacement.id);
                return true;
            })
            .map(assignment => ({
                id: `replacement:${assignment.id}`,
                staffId: assignment.replacement!.id,
                locationId: assignment.locationId,
                date: assignment.shiftDate,
                startTime: assignment.shiftStartTime,
                endTime: assignment.shiftEndTime,
                staff: assignment.replacement!,
                location: assignment.location,
                isAcceptedReplacementPendingSync: true
            }));
        const effectiveScheduledShifts = scheduledShifts.filter(shift => !replacedScheduledShiftKeys.has(
            `${shift.staffId}:${getScheduleSlotKey(shift.locationId, shift.date)}`
        ));
        const todayShifts = [...effectiveScheduledShifts, ...acceptedPendingSync];

        if (todayShifts.length === 0) {
            logger.debug({ date: startOfDay.toISOString() }, "Shift reminders skipped because no shifts were found");
            return;
        }

        for (const shift of todayShifts) {
            const staff = shift.staff;
            const telegramId = (staff as any).user?.telegramId;
            const reminderKey = `shift-reminder:${startOfDay.toISOString().slice(0, 10)}:${staff.id}:${shift.id}`;

            if (!telegramId) {
                logger.warn({ staffId: staff.id }, "Shift reminder skipped because staff Telegram ID is missing");
                continue;
            }

            let reminderClaimed = false;
            try {
                const claimResult = await redis.set(reminderKey, "sending", "EX", 3 * 24 * 60 * 60, "NX");
                if (claimResult !== "OK") {
                    logger.debug({ staffId: staff.id, shiftId: shift.id }, "Shift reminder already handled");
                    continue;
                }
                reminderClaimed = true;

                const dateStr = shift.date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: KYIV_TIME_ZONE });
                const pendingSyncText = "isAcceptedReplacementPendingSync" in shift && shift.isAcceptedReplacementPendingSync
                    ? `\n${STAFF_TEXTS["staff-replacement-pending-sync-reminder"]}`
                    : "";
                const shiftText = `🏃 <b>Сьогодні (${dateStr}) у тебе зміна в ${escapeHtml(shift.location.name)}!</b> 📸${pendingSyncText}\nВдалого дня та гарних знімків! ✨`;

                const tasks = await taskService.getStaffActiveTasks(staff.id);
                const activeTasksCount = tasks.filter(t => !t.isCompleted).length;
                const taskSummary = activeTasksCount > 0
                    ? `\n\n🔴 <b>У тебе є активні завдання (${activeTasksCount})!</b>\nПереглянь їх у розділі «Мої завдання». 👇`
                    : "";

                const pendingParcelsCount = await prisma.parcel.count({
                    where: {
                        locationId: shift.locationId,
                        OR: [
                            { status: { in: ['EXPECTED', 'ARRIVED'] } },
                            { status: 'DELIVERED', contentPhotoIds: { isEmpty: true } }
                        ]
                    }
                });

                const parcelsSummary = pendingParcelsCount > 0
                    ? `\n\n📦 <b>Активні посилки на локації: ${pendingParcelsCount} шт.</b>\nВідкрий меню «📦 Посилки локації»: там можуть бути як посилки на забір, так і посилки, де треба дозавантажити фото вмісту.`
                    : "";

                const firstName = staff.fullName?.split(' ')[1] || staff.fullName?.split(' ')[0] || 'фотографине';
                const greeting = `👋 <b>Доброго ранку, ${escapeHtml(firstName)}!</b>\n\nОсь твій робочий хаб на сьогодні:`;

                const fullText = `${greeting}\n\n${shiftText}${taskSummary}${parcelsSummary}`;
                const kb = new InlineKeyboard().text("🚀 Відкрити Хаб", "staff_hub_nav");

                await bot.api.sendMessage(Number(telegramId), fullText, {
                    parse_mode: "HTML",
                    reply_markup: kb
                });
                logger.debug({ telegramId, staffId: staff.id, locationId: shift.locationId }, "Shift reminder sent");
            } catch (err) {
                logger.error({ err, telegramId, staffId: staff.id, locationId: shift.locationId }, "Shift reminder delivery failed");
                if (reminderClaimed) {
                    await redis.del(reminderKey).catch(deleteError => {
                        logger.error({ err: deleteError, reminderKey }, "Failed to release shift reminder claim");
                    });
                }
            }
        }

        logBusinessEvent({
            event: "staff.shift_reminders.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "shift-reminder-service",
            operation: "sendDailyShiftReminders",
            safeContext: {
                shiftsCount: todayShifts.length,
                scheduledShiftsCount: effectiveScheduledShifts.length,
                acceptedPendingSyncCount: acceptedPendingSync.length
            },
        });
    } catch (error) {
        logger.error({ err: error }, "Shift reminder job failed");
        logBusinessEvent({
            event: "staff.shift_reminders.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "SHIFT_REMINDER_JOB_FAILED",
            module: "shift-reminder-service",
            operation: "sendDailyShiftReminders",
            error,
        });
    }
}

export function startShiftReminderLoop(bot: Bot<MyContext>) {
    const scheduleNextRun = () => {
        const now = new Date();
        const nextRun = getNextShiftReminderAt(now);
        const delay = nextRun.getTime() - now.getTime();
        logBusinessEvent({
            event: "staff.shift_reminder_loop.started",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "shift-reminder-service",
            operation: "startShiftReminderLoop",
            safeContext: {
                nextRunAt: nextRun.toISOString(),
                delayHours: Number((delay / 1000 / 60 / 60).toFixed(2)),
            },
        });

        setTimeout(async () => {
            try {
                await sendDailyShiftReminders(bot);
            } catch (error) {
                logger.error({ err: error }, "Shift reminder run failed");
            } finally {
                scheduleNextRun();
            }
        }, delay);
    };

    scheduleNextRun();
}
