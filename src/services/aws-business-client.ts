import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    AWS_BUSINESS_API_TOKEN,
    AWS_BUSINESS_API_URL,
} from "../config.js";

/**
 * Thrown for a non-2xx response whose body could be parsed as the backend's
 * RFC 9457 problem-details shape, carrying the machine-readable `code` a
 * caller needs to react to a *specific* failure — e.g.
 * REPLACEMENT_REVERT_NEEDS_ACKNOWLEDGEMENT, which must prompt the owner
 * rather than read as a generic failure. Every other caller in this file
 * that only needs "did it work" keeps working unchanged: this still extends
 * Error and every existing `catch` that just logs `error.message` sees a
 * sensible message.
 */
export class AwsBusinessApiError extends Error {
    /**
     * Set only on REPLACEMENT_WAVE_NOT_DUE: when the backend says the next wave
     * actually becomes due. The bot paces its polling by this rather than by a
     * guess of its own.
     */
    public nextWaveAt?: string;

    constructor(
        public readonly status: number,
        public readonly code: string | undefined,
        message: string
    ) {
        super(message);
        this.name = "AwsBusinessApiError";
    }
}

/**
 * One canonical opening-hours row. `dayOfWeek` is ISO-8601 (1 = Monday … 7 = Sunday) and the
 * times are local wall-clock for the location's timezone, so they are never re-converted.
 * `closes` < `opens` means the shift runs past midnight.
 */
const openingHoursSchema = z.object({
    dayOfWeek: z.number().int().min(1).max(7),
    opens: z.string().regex(/^\d{2}:\d{2}$/u),
    closes: z.string().regex(/^\d{2}:\d{2}$/u),
}).strict();

const locationSchema = z.object({
    publicId: z.string().uuid(),
    canonicalCode: z.string().min(1),
    name: z.string().min(1),
    /**
     * Disambiguates same-named venues, e.g. the three Zaporizhzhia Volklands.
     *
     * Optional so the bot can be deployed before the backend that sends it: an older API
     * omits the field, and requiring it would make the whole snapshot fail validation and
     * stop schedule syncing. Absent simply means "no branch known yet".
     */
    branch: z.string().nullable().optional().default(null),
    city: z.string().min(1),
    address: z.string().nullable(),
    timezone: z.string().min(1),
    /**
     * Empty when the owner has not recorded hours; never defaulted to a guess.
     * Optional for the same deploy-ordering reason as `branch` — an older API omits it,
     * and the display layer already falls back to the legacy text schedule.
     */
    openingHours: z.array(openingHoursSchema).optional().default([]),
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
        /**
         * When the backend will run the next wave, or null once it has stopped
         * pacing this request (found, cancelled, expired). The bot schedules
         * its next poll from this instead of keeping a wave clock of its own.
         */
        nextWaveAt: z.string().nullable().optional(),
    })
    .passthrough();

/**
 * Отказ — единственный ответ кандидатки, на который бэкенд не возвращает запрос
 * целиком: отказ ничего в нём не меняет, поэтому приходит только подтверждение
 * `{ status: "DECLINED" }`. Разбор этого ответа схемой полного запроса валил
 * каждое нажатие «Не можу» уже после успешного HTTP 200 — ошибка выходила без
 * `code`, и фотографе показывалось «Спробуй ще раз за хвилину».
 */
const replacementDeclineSchema = z
    .object({ status: z.literal("DECLINED") })
    .passthrough();

/**
 * Поля бэкенда, которые бот пока не использует, объявляются ЗДЕСЬ и
 * необязательными.
 *
 * Схема `.strict()`, поэтому новое поле в ответе роняет `parse`, а этот запрос
 * сидит внутри `saveCanonicalPreference` (читает версию перед записью) — то
 * есть падение означает «фотограф не может сохранить побажання». `worksUntil`
 * добавлялся именно так и по этой причине объявлен, хотя нужен только
 * календарю.
 *
 * `.strict()` тем не менее оставлен намеренно: он ловит опечатки в именах.
 * Цена — объявлять новые поля здесь, и это дешевле, чем молча принимать что
 * угодно. `collectionOpen` говорит, открыт ли ещё сбор на месяц.
 */
const schedulePreferenceReadSchema = z.union([
    z
        .object({
            exists: z.literal(false),
            worksUntil: z.string().nullish(),
            collectionOpen: z.boolean().optional(),
        })
        .strict(),
    z
        .object({
            exists: z.literal(true),
            worksUntil: z.string().nullish(),
            version: z.number().int(),
            status: z.enum(["SUBMITTED", "DECLINED"]),
            days: z.array(z.object({ localDate: z.string(), kind: z.string() }).strict()),
            collectionOpen: z.boolean().optional(),
        })
        .strict(),
]);

const schedulePreferenceWindowSchema = z
    .object({ month: z.string().min(1), open: z.boolean() })
    .strict();

const missingPreferencesSchema = z
    .object({
        month: z.string().min(1),
        items: z.array(
            z
                .object({
                    employeePublicId: z.string().uuid(),
                    telegramId: z.string().regex(/^\d+$/u),
                })
                .strict()
        ),
    })
    .strict();

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

const parcelsSchema = z.object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    parcels: z.array(
        z.object({
            ttn: z.string(),
            status: z.string(),
            locationPublicId: z.string().nullable(),
            npAddress: z.string().nullable(),
            npCity: z.string().nullable(),
            scheduledDate: z.string().nullable(),
            arrivedAt: z.string().nullable(),
        }),
    ),
});
export type AwsParcels = z.infer<typeof parcelsSchema>;

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
    /** Present only when the catalogue records one; the sole thing telling same-named venues apart. */
    locationBranch: z.string().min(1).optional(),
    locationCity: z.string().min(1),
});

/** Mirrors the backend's exported `ScheduleNotificationPayload`. */
const scheduleNotificationPayloadSchema = z.object({
    before: scheduleNotificationSnapshotSchema.optional(),
    after: scheduleNotificationSnapshotSchema.optional(),
    reason: z.string().optional(),
    replacementPublicId: z.string().optional(),
    role: z.enum(["accepted", "requester"]).optional(),
    // Only present when role is "accepted": what the undo button on this
    // message calls POST /offers/:offerPublicId/undo with.
    offerPublicId: z.string().optional(),
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

/**
 * Mirrors the backend's `buildReplacementNotificationPayload`
 * (`apps/api/src/replacements/replacement-notifications.service.ts`) — derived
 * from that function's actual output, not from a written description of it.
 *
 * Not `.strict()`: the backend may add fields (it already documents the shape
 * as "flat and additive"), and unknown extra keys must not throw here.
 */
const replacementNotificationPayloadSchema = z.object({
    startsAtLocal: z.string().min(1),
    endsAtLocal: z.string().min(1),
    timezone: z.string().min(1),
    locationPublicId: z.string().min(1),
    locationName: z.string().min(1),
    /** Present only when the catalogue records one; the sole thing telling same-named venues apart. */
    locationBranch: z.string().min(1).optional(),
    locationCity: z.string().min(1),
    replacementPublicId: z.string().min(1),
    candidatePublicId: z.string().optional(),
    /**
     * OFFER only: what the accept and decline buttons on this message call
     * `POST /offers/:offerPublicId/{accept,decline}` with.
     *
     * Optional so a backend that has not shipped it yet still validates — the
     * whole notification would otherwise fail to parse and nobody would be told
     * about the shift at all. Absent means the message goes out without buttons.
     */
    offerPublicId: z.string().optional(),
    /**
     * OFFER only: whether this candidate had marked the day unavailable when she
     * was selected. Decides the wording — acknowledging a preference she never
     * stated claims something untrue about her.
     *
     * Optional, and unknown values are tolerated rather than rejected: a new
     * availability kind added upstream must not make the notification fail to
     * parse and leave her unaware of the shift entirely.
     */
    availabilityKind: z.string().optional(),
    requesterDisplayName: z.string().optional(),
    candidateDisplayName: z.string().optional(),
    outcome: z.enum(["confirmed", "needs_review"]).optional(),
    // ACCEPTANCE_REVERTED only: who undid the acceptance. Same problem
    // `outcome` solves for ACCEPTED_OWNER_REVIEW — without this the bot
    // cannot tell a candidate's own mis-tap undo apart from an owner revert
    // and would blame "an administrator" for something nobody but the
    // candidate herself did.
    revertedBy: z.enum(["candidate", "owner"]).optional(),
});

const replacementNotificationSchema = z.object({
    publicId: z.string().min(1),
    kind: z.enum([
        "OFFER",
        "OFFER_CLOSED",
        "OFFER_REOPENED",
        "ACCEPTED_OWNER_REVIEW",
        "ACCEPTANCE_REVERTED",
        "OPEN_SHIFT_OFFER",
        "SEARCH_STARTED",
    ]),
    telegramId: z.string().regex(/^\d+$/u).nullable(),
    payload: replacementNotificationPayloadSchema,
});

/**
 * Same shape as `pendingScheduleNotificationsEnvelopeSchema`: rows are parsed
 * one at a time so a single malformed row cannot abort the whole batch.
 */
const pendingReplacementNotificationsEnvelopeSchema = z.object({
    items: z.array(z.unknown()),
});

const replacementNotificationIdentitySchema = z.object({
    publicId: z.string().min(1),
});

/** Valid rows plus the ids of rows that failed validation and must be reported. */
export interface AwsPendingReplacementNotifications {
    items: AwsReplacementNotification[];
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
/**
 * Derived from the schema rather than restated, so a field added to the parse
 * (like `nextWaveAt`) is visible to callers instead of silently dropping out of
 * the type while still arriving at runtime.
 */
export type ReplacementRequestView = z.infer<typeof replacementRequestSchema>;
export type ReplacementDeclineAck = z.infer<typeof replacementDeclineSchema>;
export type SchedulePreferenceRead = z.infer<typeof schedulePreferenceReadSchema>;
export type MissingSchedulePreferences = z.infer<typeof missingPreferencesSchema>;
export type AwsReplacementNotification = z.infer<typeof replacementNotificationSchema>;
export type AwsReplacementNotificationKind = AwsReplacementNotification["kind"];
export type AwsReplacementNotificationPayload = z.infer<typeof replacementNotificationPayloadSchema>;

/**
 * One queued row from Task 5's access-revocation queue. `.strict()` like its
 * neighbours: every field the API sends must be listed here, or `parse` throws
 * on the whole response and the feature breaks silently.
 */
const accessRevocationsSchema = z
    .object({
        items: z.array(
            z
                .object({
                    publicId: z.string().uuid(),
                    telegramId: z.string().regex(/^\d+$/u),
                    kind: z.enum(["REVOKE", "RESTORE"]),
                    reason: z.string(),
                })
                .strict(),
        ),
    })
    .strict();

export type AwsAccessRevocationRow = z.infer<typeof accessRevocationsSchema>["items"][number];
export type AwsAccessRevocationKind = AwsAccessRevocationRow["kind"];

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

/**
 * Полный снимок кандидата для зеркала рекрутинга в вебаппе. Бот шлёт ВЕСЬ
 * профиль на каждом пуше: отсутствующее в боте поле уходит как null и
 * перезаписывает колонку зеркала — так пропущенный пуш самоизлечивается
 * следующим. Каждая дата — строгая ISO-строка или null; `telegramId` —
 * строка из цифр (BigInt не переживает JSON.stringify).
 *
 * Контракт приёмной стороны: вебапп,
 * `apps/api/src/recruiting/dto/bot-candidate-upsert.dto.ts`.
 */
export interface RecruitingCandidateSnapshot {
    telegramId: string;
    botCandidateId: string;
    telegramUsername: string | null;
    fullName: string | null;
    phone: string | null;
    gender: "female" | "male" | null;
    birthDate: string | null;
    city: string | null;
    locationCode: string | null;
    source: string | null;
    botStatus: string;
    hrDecision: string | null;
    lossStage: string | null;
    lossReason: string | null;
    interviewAt: string | null;
    statusChangedAt: string | null;
    lastActivityAt: string | null;
    botCreatedAt: string | null;
}

/**
 * Подтверждение зеркала. НЕ `.strict()` — сознательно: разбор ответа строгой
 * схемой уже ронял сохранение побажань, когда API добавил новое поле, а этот
 * пуш сидит в хвосте каждой записи кандидата. Новое поле в ответе не должно
 * превращаться в вечно падающий джоб.
 */
const recruitingCandidateAckSchema = z.object({
    publicId: z.string(),
    stage: z.string(),
});

export type RecruitingCandidateAck = z.infer<typeof recruitingCandidateAckSchema>;

const locationCutoverSchema = z.object({
    items: z.array(
        z.object({
            canonicalCode: z.string(),
            inAppSince: z.string().nullable(),
        })
    ),
});

export class AwsBusinessClient {
    async snapshot(from: string, to: string): Promise<AwsBusinessSnapshot> {
        const query = new URLSearchParams({ from, to });
        const value = await this.request(`/business-snapshot?${query.toString()}`, { method: "GET" });
        return snapshotSchema.parse(value);
    }

    /**
     * Проводит выручку локации в ДДС вебаппа.
     *
     * Идемпотентно на стороне API: повторный вызов за тот же день, локацию и
     * канал возвращает исходную проводку, а не создаёт вторую.
     *
     * Отказ `LOCATION_ALREADY_IN_APP` означает, что локация успела переехать и
     * её выручка приходит из касс приложения — это ожидаемый ответ, а не сбой.
     */
    async recordDdsRevenue(payment: {
        paidOn: string;
        locationCode: string;
        walletCode: string;
        articleCode: string;
        amount: string;
        paymentMethod: "CASH" | "TERMINAL" | "UNKNOWN";
        purpose?: string;
    }) {
        return this.request("/treasury/payments", {
            method: "POST",
            body: JSON.stringify(payment),
        });
    }

    /**
     * С какого дня каждая локация записывает продажи в приложении.
     *
     * `inAppSince = null` — локация ещё вне контура, её кассу по-прежнему ведёт
     * бот. Список читается перед синхронизацией, чтобы не писать в ДДС то, что
     * уже пришло из `Sale`.
     */
    async locationCutover(): Promise<{
        items: Array<{ canonicalCode: string; inAppSince: string | null }>;
    }> {
        const value = await this.request("/locations/cutover", { method: "GET" });
        return locationCutoverSchema.parse(value);
    }

    /**
     * Зеркалит один снимок кандидата в вебапп. Идемпотентно на стороне API:
     * upsert по `telegramId`, повторный пуш того же состояния безвреден —
     * поэтому BullMQ-ретраи и бэкфилл могут накладываться без последствий.
     */
    async pushRecruitingCandidate(snapshot: RecruitingCandidateSnapshot): Promise<RecruitingCandidateAck> {
        const body = await this.request("/recruiting/candidates", {
            method: "POST",
            body: JSON.stringify(snapshot),
        });
        return recruitingCandidateAckSchema.parse(body);
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

    async parcels(options: { timeoutMs?: number } = {}): Promise<AwsParcels> {
        const value = await this.request("/parcels", { method: "GET" }, options.timeoutMs);
        return parcelsSchema.parse(value);
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

    /**
     * Reports which telegram ids the bot recognises (a row exists in its own
     * `User` table). This is advisory only — it drives the backend's onboarding
     * verification badge and never affects scheduling — so callers must swallow
     * failures rather than let them interrupt a sync.
     */
    async reportTelegramLinks(
        links: Array<{ telegramId: string; found: boolean; username?: string }>
    ): Promise<{ updated: number }> {
        return this.request("/telegram-links", {
            method: "POST",
            body: JSON.stringify({ links }),
        }) as Promise<{ updated: number }>;
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

    /**
     * Вакансія: на зміні ще нікого немає. Бекенд перевіряє, що предложення
     * належить саме цій людині і що зміну ще не взяли, тож повторної
     * перевірки тут немає — той самий поділ, що й у замін.
     */
    async acceptOpenShiftOffer(
        offerPublicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<void> {
        await this.request(
            `/open-shifts/offers/${encodeURIComponent(offerPublicId)}/accept`,
            { method: "POST", body: JSON.stringify(input) },
        );
    }

    async declineOpenShiftOffer(
        offerPublicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<void> {
        await this.request(
            `/open-shifts/offers/${encodeURIComponent(offerPublicId)}/decline`,
            { method: "POST", body: JSON.stringify(input) },
            undefined,
            { expectsBody: false },
        );
    }

    async declineReplacementOffer(
        offerPublicId: string,
        input: { employeePublicId: string; telegramId: string },
    ): Promise<ReplacementDeclineAck> {
        const body = await this.request(
            `/replacements/offers/${encodeURIComponent(offerPublicId)}/decline`,
            { method: "POST", body: JSON.stringify(input) },
        );
        return replacementDeclineSchema.parse(body);
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
     * Undoes an acceptance made by mistake, within the backend's short undo
     * window. The backend re-verifies the candidate against the offer itself,
     * same as accept/decline — this call cannot undo someone else's offer.
     */
    async undoReplacementAcceptance(
        offerPublicId: string,
        employeePublicId: string,
        telegramId: string,
    ): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/offers/${encodeURIComponent(offerPublicId)}/undo`,
            { method: "POST", body: JSON.stringify({ employeePublicId, telegramId }) },
        );
        return replacementRequestSchema.parse(body);
    }

    /**
     * Reverts an auto-confirmed replacement on the owner's behalf. No telegram
     * id travels in the body: the backend has no telegram id on the owner
     * model to verify against, so it records this action as SYSTEM rather than
     * as a specific person. The caller (Task 12's handler) is responsible for
     * checking the requester is in ADMIN_IDS before ever reaching this method.
     */
    async revertReplacementAsOwner(
        requestPublicId: string,
        acknowledgeLateRevert: boolean,
    ): Promise<ReplacementRequestView> {
        const body = await this.request(
            `/replacements/${encodeURIComponent(requestPublicId)}/revert`,
            { method: "POST", body: JSON.stringify({ acknowledgeLateRevert }) },
        );
        return replacementRequestSchema.parse(body);
    }

    /**
     * Fetches replacement notifications awaiting Telegram delivery, validating
     * each row on its own — same shape as `pendingScheduleNotifications`, so a
     * single malformed row cannot abort delivery for everyone else in the pass.
     */
    async pendingReplacementNotifications(limit: number): Promise<AwsPendingReplacementNotifications> {
        const query = new URLSearchParams({ limit: String(limit) });
        const value = await this.request(
            `/replacement-notifications/pending?${query.toString()}`,
            { method: "GET" },
        );
        const envelope = pendingReplacementNotificationsEnvelopeSchema.parse(value);

        const items: AwsReplacementNotification[] = [];
        const invalidPublicIds: string[] = [];
        let unidentifiableCount = 0;

        for (const row of envelope.items) {
            const parsed = replacementNotificationSchema.safeParse(row);
            if (parsed.success) {
                items.push(parsed.data);
                continue;
            }
            const identity = replacementNotificationIdentitySchema.safeParse(row);
            if (identity.success) invalidPublicIds.push(identity.data.publicId);
            else unidentifiableCount += 1;
        }

        return { items, invalidPublicIds, unidentifiableCount };
    }

    async markReplacementNotificationDelivered(publicId: string): Promise<void> {
        await this.request(
            `/replacement-notifications/${encodeURIComponent(publicId)}/delivered`,
            { method: "POST", body: JSON.stringify({}) },
            undefined,
            { expectsBody: false },
        );
    }

    async markReplacementNotificationFailed(publicId: string, reason: string): Promise<void> {
        await this.request(
            `/replacement-notifications/${encodeURIComponent(publicId)}/failed`,
            { method: "POST", body: JSON.stringify({ reason: reason.slice(0, 500) }) },
            undefined,
            { expectsBody: false },
        );
    }

    /**
     * Reads the current monthly preference submission, if any, so the caller
     * can echo its `version` back on write. `telegramId` is required by the
     * backend and validated against the employee's stored id — a mismatch is
     * a 404, deliberately, so the bot cannot read a version it would then
     * fail to write with.
     */
    /**
     * Открыт ли сбор пожеланий на месяц. Меню спрашивает это, чтобы решить,
     * показывать ли кнопку «Побажання»: раньше признак брался из ключа в Redis,
     * который писала только ветка синхронизации с Google Sheets, а прод её не
     * выполняет — из-за чего кнопка висела в меню и после публикации графика.
     */
    async schedulePreferenceWindow(month: string): Promise<{ month: string; open: boolean }> {
        const query = new URLSearchParams({ month });
        const body = await this.request(
            `/schedule-preferences/collection-window?${query.toString()}`,
            { method: "GET" },
        );
        return schedulePreferenceWindowSchema.parse(body);
    }

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

    /**
     * Lists employees who have not yet submitted a schedule preference for
     * `month`, replacing the Redis `pref_filled:*` TTL-key lookup the bot
     * previously used to decide who to remind.
     */
    async missingSchedulePreferences(month: string): Promise<MissingSchedulePreferences> {
        const body = await this.request(
            `/schedule-preferences/missing?month=${encodeURIComponent(month)}`,
            { method: "GET" }
        );
        return missingPreferencesSchema.parse(body);
    }

    /**
     * Fetches queued access-revocation rows Task 5's API has decided on: who
     * loses access (REVOKE) and who gets it back (RESTORE). Unlike the
     * schedule/replacement notification feeds this is parsed as a single
     * strict batch rather than row-by-row — a contract drift here must fail
     * loudly rather than silently drop rows, since a dropped REVOKE row means
     * someone keeps channel access they should have lost.
     */
    async pendingAccessRevocations(limit: number): Promise<{ items: AwsAccessRevocationRow[] }> {
        const query = new URLSearchParams({ limit: String(limit) });
        const value = await this.request(
            `/access-revocations/pending?${query.toString()}`,
            { method: "GET" },
        );
        return accessRevocationsSchema.parse(value);
    }

    async markAccessRevocationProcessed(publicId: string): Promise<void> {
        await this.request(
            `/access-revocations/${encodeURIComponent(publicId)}/processed`,
            { method: "POST", body: JSON.stringify({}) },
            undefined,
            { expectsBody: false },
        );
    }

    async markAccessRevocationFailed(publicId: string, reason: string): Promise<void> {
        await this.request(
            `/access-revocations/${encodeURIComponent(publicId)}/failed`,
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
            // Best-effort: a body that isn't the expected problem-details JSON
            // (a proxy error page, an empty body) must still produce *some*
            // error rather than throw a secondary parse failure that hides
            // the original HTTP status. `.clone()` is unneeded — this is the
            // only place on the non-ok branch that reads the body.
            const problem = await response
                .json()
                .then((body: unknown) =>
                    typeof body === "object" && body !== null
                        ? (body as { code?: unknown; nextWaveAt?: unknown })
                        : {}
                )
                .catch(() => ({}) as { code?: unknown; nextWaveAt?: unknown });
            const error = new AwsBusinessApiError(
                response.status,
                problem.code === undefined ? undefined : String(problem.code),
                `AWS business API request failed with HTTP ${response.status}`
            );
            // REPLACEMENT_WAVE_NOT_DUE carries when the wave actually becomes
            // due. Without it a caller polling too early has nothing to
            // reschedule against and would either drop the request or spin.
            if (typeof problem.nextWaveAt === "string") error.nextWaveAt = problem.nextWaveAt;
            throw error;
        }
        if (options.expectsBody === false) {
            return undefined;
        }
        return response.json();
    }
}

export const awsBusinessClient = new AwsBusinessClient();
