import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    AWS_BUSINESS_API_TOKEN,
    AWS_BUSINESS_API_URL,
} from "../config.js";

const locationSchema = z.object({
    publicId: z.string().uuid(),
    canonicalCode: z.string().min(1),
    name: z.string().min(1),
    city: z.string().min(1),
    address: z.string().nullable(),
    timezone: z.string().min(1),
}).strict();

const assignmentSchema = z.object({
    type: z.enum(["PERMANENT", "TEMPORARY"]),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable(),
    locationPublicId: z.string().uuid(),
    locationCode: z.string().min(1),
}).strict();

const employeeSchema = z.object({
    publicId: z.string().uuid(),
    telegramId: z.string().regex(/^\d+$/u),
    fullName: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    patronymic: z.string().nullable(),
    phone: z.string().nullable(),
    telegramUsername: z.string().nullable(),
    birthDate: z.string().date().nullable(),
    hiredAt: z.string().date().nullable(),
    status: z.enum(["ACTIVE", "DEACTIVATED"]),
    assignments: z.array(assignmentSchema),
}).strict();

const shiftSchema = z.object({
    publicId: z.string().uuid(),
    employeePublicId: z.string().uuid(),
    employeeTelegramId: z.string().regex(/^\d+$/u),
    locationPublicId: z.string().uuid(),
    locationCode: z.string().min(1),
    localDate: z.string().date(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
}).strict();

const snapshotSchema = z.object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    completeEmployeeSnapshot: z.literal(true),
    completeLocationSnapshot: z.literal(true),
    scheduleWindow: z.object({ from: z.string().date(), to: z.string().date() }).strict(),
    locations: z.array(locationSchema),
    employees: z.array(employeeSchema),
    shifts: z.array(shiftSchema),
}).strict();

const employeeScheduleSchema = z.object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    employeePublicId: z.string().uuid(),
    scheduleWindow: z.object({ from: z.string().date(), to: z.string().date() }).strict(),
    shifts: z.array(z.object({
        publicId: z.string().uuid(),
        locationPublicId: z.string().uuid(),
        localDate: z.string().date(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
    }).strict()),
}).strict();

/**
 * Mirrors the backend's exported `ScheduleNotificationShiftSnapshot`.
 *
 * `startsAtLocal` / `endsAtLocal` are already local wall-clock strings for the
 * location's timezone — they must never be re-converted. `locationPublicId` is
 * for correlation only and must never be shown to a photographer. The contract
 * deliberately carries no employee name, phone, or Telegram id.
 *
 * Not `.strict()`: unknown extra keys must not throw, so the backend can add
 * fields without breaking delivery.
 */
const scheduleNotificationSnapshotSchema = z.object({
    startsAtLocal: z.string().min(1),
    endsAtLocal: z.string().min(1),
    timezone: z.string().min(1),
    locationPublicId: z.string().min(1),
    locationName: z.string().min(1),
    locationCity: z.string().min(1),
});

/** Mirrors the backend's exported `ScheduleNotificationPayload`. */
const scheduleNotificationPayloadSchema = z.object({
    before: scheduleNotificationSnapshotSchema.optional(),
    after: scheduleNotificationSnapshotSchema.optional(),
    reason: z.string().optional(),
    replacementPublicId: z.string().optional(),
    role: z.enum(["accepted", "requester"]).optional(),
});

const scheduleNotificationSchema = z.object({
    publicId: z.string().min(1),
    employeePublicId: z.string().min(1),
    telegramId: z.string().regex(/^\d+$/u).nullable(),
    changeKind: z.enum(["SHIFT_ADDED", "SHIFT_REMOVED", "SHIFT_MOVED", "SHIFT_REASSIGNED"]),
    urgency: z.enum(["NORMAL", "URGENT"]),
    batchId: z.string().min(1).nullable(),
    payload: scheduleNotificationPayloadSchema,
});

const pendingScheduleNotificationsSchema = z.object({
    items: z.array(scheduleNotificationSchema),
});

export type AwsBusinessSnapshot = z.infer<typeof snapshotSchema>;
export type AwsEmployeeSchedule = z.infer<typeof employeeScheduleSchema>;
export type AwsScheduleNotification = z.infer<typeof scheduleNotificationSchema>;
export type AwsScheduleChangeKind = AwsScheduleNotification["changeKind"];
export type AwsScheduleNotificationUrgency = AwsScheduleNotification["urgency"];
export type AwsScheduleNotificationPayload = z.infer<typeof scheduleNotificationPayloadSchema>;
export type AwsScheduleNotificationShiftSnapshot = z.infer<typeof scheduleNotificationSnapshotSchema>;

export interface AwsEmployeeUpsert {
    telegramId: string;
    firstName: string;
    lastName: string;
    patronymic?: string;
    phone?: string;
    telegramUsername?: string;
    birthDate?: string;
    hiredAt?: string;
    locationCode: string;
}

export class AwsBusinessClient {
    async snapshot(from: string, to: string): Promise<AwsBusinessSnapshot> {
        const query = new URLSearchParams({ from, to });
        const value = await this.request(`/business-snapshot?${query.toString()}`, { method: "GET" });
        return snapshotSchema.parse(value);
    }

    async upsertEmployee(employee: AwsEmployeeUpsert) {
        return this.request("/employees", {
            method: "POST",
            body: JSON.stringify(employee),
        });
    }

    async employeeSchedule(
        employeePublicId: string,
        from: string,
        to: string,
        options: { timeoutMs?: number } = {}
    ): Promise<AwsEmployeeSchedule> {
        const query = new URLSearchParams({ from, to });
        const value = await this.request(
            `/employees/${encodeURIComponent(employeePublicId)}/schedule?${query.toString()}`,
            { method: "GET" },
            options.timeoutMs,
        );
        const schedule = employeeScheduleSchema.parse(value);
        if (schedule.employeePublicId !== employeePublicId) {
            throw new Error("AWS business API returned a schedule for another employee");
        }
        return schedule;
    }

    async pendingScheduleNotifications(limit: number): Promise<AwsScheduleNotification[]> {
        const query = new URLSearchParams({ limit: String(limit) });
        const value = await this.request(
            `/schedule-notifications/pending?${query.toString()}`,
            { method: "GET" },
        );
        return pendingScheduleNotificationsSchema.parse(value).items;
    }

    async markScheduleNotificationDelivered(publicId: string): Promise<void> {
        await this.request(
            `/schedule-notifications/${encodeURIComponent(publicId)}/delivered`,
            { method: "POST", body: JSON.stringify({}) },
            undefined,
            { expectsBody: false },
        );
    }

    async markScheduleNotificationFailed(publicId: string, reason: string): Promise<void> {
        await this.request(
            `/schedule-notifications/${encodeURIComponent(publicId)}/failed`,
            { method: "POST", body: JSON.stringify({ reason: reason.slice(0, 500) }) },
            undefined,
            { expectsBody: false },
        );
    }

    private async request(
        path: string,
        init: RequestInit,
        timeoutMs: number = 20_000,
        options: { expectsBody?: boolean } = {},
    ): Promise<unknown> {
        const base = AWS_BUSINESS_API_URL.replace(/\/$/u, "");
        const response = await fetch(`${base}${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${AWS_BUSINESS_API_TOKEN}`,
                "content-type": "application/json",
                "x-request-id": `telegram-bot:${randomUUID()}`,
                ...init.headers,
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            throw new Error(`AWS business API request failed with HTTP ${response.status}`);
        }
        if (options.expectsBody === false) {
            return undefined;
        }
        return response.json();
    }
}

export const awsBusinessClient = new AwsBusinessClient();
