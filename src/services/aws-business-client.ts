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

export type AwsBusinessSnapshot = z.infer<typeof snapshotSchema>;
export type AwsEmployeeSchedule = z.infer<typeof employeeScheduleSchema>;

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

    async employeeSchedule(employeePublicId: string, from: string, to: string): Promise<AwsEmployeeSchedule> {
        const query = new URLSearchParams({ from, to });
        const value = await this.request(
            `/employees/${encodeURIComponent(employeePublicId)}/schedule?${query.toString()}`,
            { method: "GET" },
        );
        const schedule = employeeScheduleSchema.parse(value);
        if (schedule.employeePublicId !== employeePublicId) {
            throw new Error("AWS business API returned a schedule for another employee");
        }
        return schedule;
    }

    private async request(path: string, init: RequestInit): Promise<unknown> {
        const base = AWS_BUSINESS_API_URL.replace(/\/$/u, "");
        const response = await fetch(`${base}${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${AWS_BUSINESS_API_TOKEN}`,
                "content-type": "application/json",
                "x-request-id": `telegram-bot:${randomUUID()}`,
                ...init.headers,
            },
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
            throw new Error(`AWS business API request failed with HTTP ${response.status}`);
        }
        return response.json();
    }
}

export const awsBusinessClient = new AwsBusinessClient();
