import prisma from "../db/core.js";
import { logBusinessEvent } from "../core/log-events.js";
import { AWS_SCHEDULE_SHADOW_READ_ENABLED, BUSINESS_DATA_SOURCE } from "../config.js";
import { awsBusinessClient } from "./aws-business-client.js";
import { compareScheduleProjection, type LegacyScheduleShift } from "./aws-schedule-shadow-compare.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_WINDOW_DAYS = 62;
const SHADOW_COMPARE_COOLDOWN_MS = 5 * 60 * 1000;

export class AwsScheduleShadowService {
    private readonly lastStartedAt = new Map<string, number>();

    compareInBackground(input: {
        staffId: string;
        since: Date;
        limit: number;
        legacyShifts: LegacyScheduleShift[];
    }): void {
        if (BUSINESS_DATA_SOURCE !== "aws" || !AWS_SCHEDULE_SHADOW_READ_ENABLED) return;
        const now = Date.now();
        const lastStartedAt = this.lastStartedAt.get(input.staffId) ?? 0;
        if (now - lastStartedAt < SHADOW_COMPARE_COOLDOWN_MS) return;
        this.lastStartedAt.set(input.staffId, now);
        void this.compare(input).catch((error: unknown) => {
            logBusinessEvent({
                event: "bot.aws_schedule_shadow.failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE",
                module: "aws-schedule-shadow",
                operation: "compare",
                safeContext: {
                    errorType: error instanceof Error ? error.constructor.name : "UnknownError"
                }
            });
        });
    }

    private async compare(input: {
        staffId: string;
        since: Date;
        limit: number;
        legacyShifts: LegacyScheduleShift[];
    }): Promise<void> {
        const startedAt = Date.now();
        const staff = await prisma.staffProfile.findUnique({
            where: { id: input.staffId },
            select: { awsEmployeePublicId: true }
        });
        if (!staff?.awsEmployeePublicId) {
            logBusinessEvent({
                event: "bot.aws_schedule_shadow.skipped",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "skipped",
                reasonCode: "EMPLOYEE_NOT_MAPPED",
                module: "aws-schedule-shadow",
                operation: "compare"
            });
            return;
        }

        const from = localDate(input.since, "Europe/Kyiv");
        const to = addDays(from, MAX_SCHEDULE_WINDOW_DAYS - 1);
        const canonical = await awsBusinessClient.employeeSchedule(staff.awsEmployeePublicId, from, to);
        const legacyShifts = input.legacyShifts.filter((shift) => {
            const date = shift.date.toISOString().slice(0, 10);
            return date >= from && date <= to;
        });
        const comparison = compareScheduleProjection(legacyShifts, canonical.shifts.slice(0, input.limit));

        logBusinessEvent({
            event: "bot.aws_schedule_shadow.compared",
            level: comparison.parity ? "info" : "warn",
            actorType: "system",
            actorRole: "system",
            result: comparison.parity ? "parity" : "mismatch",
            reasonCode: comparison.parity ? undefined : "SCHEDULE_PARITY_MISMATCH",
            module: "aws-schedule-shadow",
            operation: "compare",
            durationMs: Date.now() - startedAt,
            safeContext: {
                from,
                to,
                limit: input.limit,
                ...comparison
            }
        });
    }
}

function localDate(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function addDays(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00.000Z`);
    return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export const awsScheduleShadowService = new AwsScheduleShadowService();
