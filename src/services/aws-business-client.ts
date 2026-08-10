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

const replacementCandidateSchema = z
    .object({
        employeePublicId: z.string().uuid(),
        displayName: z.string().min(1),
        availabilityKind: z.string().min(1),
    })
    .strict();

const replacementWaveSchema = z
    .object({
        wave: z.string().min(1),
        candidates: z.array(replacementCandidateSchema),
    })
    .strict();

const replacementPreviewSchema = z
    .object({
        scheduledShiftPublicId: z.string().uuid(),
        requesterEmployeePublicId: z.string().uuid(),
        locationPublicId: z.string().uuid(),
        shiftStartsAt: z.string().datetime(),
        shiftEndsAt: z.string().datetime(),
        waves: z.array(replacementWaveSchema),
    })
    .strict();

const replacementRequestSchema = z
    .object({
        publicId: z.string().uuid(),
        status: z.string().min(1),
    })
    .passthrough();

const schedulePreferenceReadSchema = z.union([
    z.object({ exists: z.literal(false) }).strict(),
    z
        .object({
            exists: z.literal(true),
            version: z.number().int(),
            status: z.enum(["SUBMITTED", "DECLINED"]),
            days: z.array(z.object({ localDate: z.string(), kind: z.string() }).strict()),
        })
        .strict(),
]);

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

/**
 * The envelope is parsed separately from its rows.
 *
 * Parsing `items` as `z.array(scheduleNotificationSchema)` made one malformed
 * row throw for the whole response, which abandoned the entire delivery pass —
 * every other photographer's notification included. Rows are validated one by
 * one instead, so a bad row is isolated rather than contagious.
 */
const pendingScheduleNotificationsEnvelopeSchema = z.object({
    items: z.array(z.unknown()),
});

/**
 * Just enough of a row to report it back to the backend when the full schema
 * rejects it. Without a usable `publicId` a bad row cannot be marked failed and
 * would be re-offered forever, so that case is counted separately.
 */
const scheduleNotificationIdentitySchema = z.object({
    publicId: z.string().min(1),
});

/** Valid rows plus the ids of rows that failed validation and must be reported. */
export interface AwsPendingScheduleNotifications {
    items: AwsScheduleNotification[];
    invalidPublicIds: string[];
    unidentifiableCount: number;
}

export type AwsBusinessSnapshot = z.infer<typeof snapshotSchema>;
export type AwsEmployeeSchedule = z.infer<typeof employeeScheduleSchema>;
export type AwsScheduleNotification = z.infer<typeof scheduleNotificationSchema>;
export type AwsScheduleChangeKind = AwsScheduleNotification["changeKind"];
export type AwsScheduleNotificationUrgency = AwsScheduleNotification["urgency"];
export type AwsScheduleNotificationPayload = z.infer<typeof scheduleNotificationPayloadSchema>;
export type AwsScheduleNotificationShiftSnapshot = z.infer<typeof scheduleNotificationSnapshotSchema>;
export type ReplacementPreview = z.infer<typeof replacementPreviewSchema>;
export type ReplacementRequestView = { publicId: string; status: string };
export type SchedulePreferenceRead = z.infer<typeof schedulePreferenceReadSchema>;

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

    /**
     * Fetches the pending rows, validating each one on its own.
     *
     * A row the strict schema rejects is separated out rather than thrown, so a
     * single malformed payload cannot abort delivery for everyone else in the
     * same pass. The caller reports the rejected ids so the backend can retire
     * them instead of re-offering them indefinitely.
     */
    async pendingScheduleNotifications(limit: number): Promise<AwsPendingScheduleNotifications> {
        const query = new URLSearchParams({ limit: String(limit) });
        const value = await this.request(
            `/schedule-notifications/pending?${query.toString()}`,
            { method: "GET" },
        );
        const envelope = pendingScheduleNotificationsEnvelopeSchema.parse(value);

        const items: AwsScheduleNotification[] = [];
        const invalidPublicIds: string[] = [];
        let unidentifiableCount = 0;

        for (const row of envelope.items) {
            const parsed = scheduleNotificationSchema.safeParse(row);
            if (parsed.success) {
                items.push(parsed.data);
                continue;
            }
            const identity = scheduleNotificationIdentitySchema.safeParse(row);
            if (identity.success) invalidPublicIds.push(identity.data.publicId);
            else unidentifiableCount += 1;
        }

        return { items, invalidPublicIds, unidentifiableCount };
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

    /**
     * Records the photographer's answer to an urgent schedule change. The backend
     * verifies the employee against the notification's own recipient and never
     * changes a shift in response — a refusal surfaces to the owner, who decides.
     */
    async acknowledgeScheduleNotification(
        publicId: string,
        employeePublicId: string,
        acknowledgement: "ACCEPTED" | "REFUSED"
    ): Promise<void> {
        await this.request(
            `/schedule-notifications/${encodeURIComponent(publicId)}/acknowledge`,
            { method: "POST", body: JSON.stringify({ employeePublicId, acknowledgement }) },
            undefined,
            { expectsBody: false },
        );
    }

    async previewReplacement(input: {
        scheduledShiftPublicId: string;
        requesterEmployeePublicId: string;
        requesterTelegramId: string;
    }): Promise<ReplacementPreview> {
        const body = await this.request("/replacements/preview", {
            method: "POST",
            body: JSON.stringify(input),
        });
        return replacementPreviewSchema.parse(body);
    }

    async createReplacement(input: {
        scheduledShiftPublicId: string;
        requesterEmployeePublicId: string;
        requesterTelegramId: string;
    }): Promise<ReplacementRequestView> {
        const body = await this.request("/replacements", {
            method: "POST",
            body: JSON.stringify(input),
        });
        return replacementRequestSchema.parse(body);
    }

    async dispatchReplacementWave(publicId: string): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/${encodeURIComponent(publicId)}/dispatch-next-wave`,
            { method: "POST", body: JSON.stringify({}) },
        );
        return replacementRequestSchema.parse(body);
    }

    async acceptReplacementOffer(
        offerPublicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/offers/${encodeURIComponent(offerPublicId)}/accept`,
            { method: "POST", body: JSON.stringify(input) },
        );
        return replacementRequestSchema.parse(body);
    }

    async declineReplacementOffer(
        offerPublicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/offers/${encodeURIComponent(offerPublicId)}/decline`,
            { method: "POST", body: JSON.stringify(input) },
        );
        return replacementRequestSchema.parse(body);
    }

    async cancelReplacement(
        publicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/${encodeURIComponent(publicId)}/cancel`,
            { method: "POST", body: JSON.stringify(input) },
        );
        return replacementRequestSchema.parse(body);
    }

    /**
     * Reads the current monthly preference submission, if any, so the caller
     * can echo its `version` back on write. `telegramId` is required by the
     * backend and validated against the employee's stored id — a mismatch is
     * a 404, deliberately, so the bot cannot read a version it would then
     * fail to write with.
     */
    async getSchedulePreference(
        employeePublicId: string,
        month: string,
        telegramId: string,
    ): Promise<SchedulePreferenceRead> {
        const query = new URLSearchParams({ telegramId });
        const body = await this.request(
            `/schedule-preferences/${encodeURIComponent(employeePublicId)}/${encodeURIComponent(month)}?${query.toString()}`,
            { method: "GET" },
        );
        return schedulePreferenceReadSchema.parse(body);
    }

    async upsertSchedulePreference(
        employeePublicId: string,
        month: string,
        body: {
            status: "SUBMITTED" | "DECLINED";
            days: Array<{ localDate: string; kind: "UNAVAILABLE" }>;
            comment?: string;
            telegramId: string;
            version?: number;
        },
    ): Promise<void> {
        await this.request(
            `/schedule-preferences/${encodeURIComponent(employeePublicId)}/${encodeURIComponent(month)}`,
            { method: "PUT", body: JSON.stringify(body) },
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
