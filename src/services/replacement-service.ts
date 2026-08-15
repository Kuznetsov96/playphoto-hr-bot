import { InlineKeyboard, type Api } from "grammy";
import {
    Prisma,
    ReplacementAvailabilityKind,
    ReplacementRequestStatus,
    ReplacementResponseStatus,
    ReplacementSearchWave,
    type Location,
    type ReplacementRequest,
    type ReplacementResponse,
    type StaffProfile,
    type User,
} from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { defaultQueue } from "../core/queue.js";
import { scheduleAvailabilityService } from "./schedule-availability-service.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { classifyAcceptedReplacement } from "./replacement-schedule-state.js";
import { kyivStartOfDay as sharedKyivStartOfDay, nextKyivDay as sharedNextKyivDay } from "./kyiv-date.js";
import { replacementShadowService } from "./replacement-shadow.js";
import { AWS_REPLACEMENTS_CANONICAL_ENABLED } from "../config.js";
import { dispatchCanonicalWave, startCanonicalReplacement } from "./replacement-canonical.js";
import { formatLocation } from "../utils/location-label.js";

/**
 * How long to wait before retrying a canonical wave the backend could not
 * answer. Matches the local dispatcher's own empty-wave retry, so an outage
 * paces the same way a wave with no candidates already does.
 */
const CANONICAL_WAVE_RETRY_MS = 60_000;

export const MAIN_ADMIN_ID = 107794048;
const KYIV_TIMEZONE = "Europe/Kyiv";
const URGENT_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const DAY_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const CONTACTED_RESPONSE_STATUSES = [
    ReplacementResponseStatus.SENT,
    ReplacementResponseStatus.ACCEPTED,
    ReplacementResponseStatus.DECLINED,
    ReplacementResponseStatus.INACTIVE,
];
const REPLACEMENT_RESTART_BLOCKING_STATUSES = [
    ReplacementRequestStatus.ACTIVE,
    ReplacementRequestStatus.FOUND,
    ReplacementRequestStatus.FAILED,
];

type StaffWithUserLocation = StaffProfile & { user: User; location: Location | null };
type RequestWithRelations = ReplacementRequest & {
    location: Location;
    requester?: (StaffProfile & { user: User }) | null;
    replacement?: (StaffProfile & { user: User }) | null;
};
type ReplacementMessageRef = Pick<ReplacementResponse, "id" | "requestId" | "chatId" | "messageId">;

export class ReplacementService {
    async listManageableRequestsForAdmin() {
        return prisma.replacementRequest.findMany({
            where: {
                OR: [
                    { status: ReplacementRequestStatus.ACTIVE },
                    {
                        status: ReplacementRequestStatus.FOUND,
                        shiftDate: { gte: this.kyivStartOfDay(new Date()) }
                    }
                ]
            },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } },
                responses: true
            },
            orderBy: [
                { status: "asc" },
                { shiftDate: "asc" },
                { createdAt: "asc" }
            ]
        });
    }

    async getConfirmedRequestForAdmin(requestId: string) {
        return prisma.replacementRequest.findFirst({
            where: {
                id: requestId,
                status: ReplacementRequestStatus.FOUND,
                replacementStaffId: { not: null }
            },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } }
            }
        });
    }

    async listSelectableShifts(staffId: string) {
        const today = this.kyivStartOfDay(new Date());
        return prisma.workShift.findMany({
            where: {
                staffId,
                date: { gte: today },
                replacementRequests: {
                    none: { status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES } }
                }
            },
            include: { location: true },
            orderBy: { date: "asc" },
            take: 12
        });
    }

    async listAcceptedAssignmentsForStaff(staffId: string, since: Date, take: number = 100) {
        return prisma.replacementRequest.findMany({
            where: {
                replacementStaffId: staffId,
                status: ReplacementRequestStatus.FOUND,
                shiftDate: { gte: since }
            },
            include: { location: true },
            orderBy: { shiftDate: "asc" },
            take
        });
    }

    async listOutgoingScheduleRequestsForStaff(staffId: string, since: Date, take: number = 100) {
        return prisma.replacementRequest.findMany({
            where: {
                requesterStaffId: staffId,
                status: { in: [ReplacementRequestStatus.ACTIVE, ReplacementRequestStatus.FOUND] },
                shiftDate: { gte: since }
            },
            include: { location: true },
            orderBy: { shiftDate: "asc" },
            take
        });
    }

    async listAcceptedAssignmentsByDateRange(start: Date, end: Date) {
        return prisma.replacementRequest.findMany({
            where: {
                replacementStaffId: { not: null },
                status: ReplacementRequestStatus.FOUND,
                shiftDate: { gte: start, lt: end }
            },
            include: {
                location: true,
                replacement: { include: { user: true } }
            },
            orderBy: { shiftDate: "asc" }
        });
    }

    async startRequest(api: Api, requesterStaffId: string, workShiftId: string) {
        const shift = await prisma.workShift.findUnique({
            where: { id: workShiftId },
            include: { location: true, staff: { include: { user: true } } }
        });

        if (!shift || shift.staffId !== requesterStaffId) {
            throw new Error("SHIFT_NOT_FOUND");
        }

        if (this.getShiftStartAt(shift) <= new Date()) {
            throw new Error("SHIFT_ALREADY_STARTED");
        }

        const existing = await prisma.replacementRequest.findFirst({
            where: {
                status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES },
                OR: [
                    { workShiftId: shift.id },
                    {
                        requesterStaffId,
                        locationId: shift.locationId,
                        shiftDate: {
                            gte: this.kyivStartOfDay(shift.date),
                            lt: this.nextKyivDay(shift.date)
                        }
                    }
                ]
            }
        });
        if (existing?.status === ReplacementRequestStatus.ACTIVE) throw new Error("REQUEST_ALREADY_ACTIVE");
        if (existing?.status === ReplacementRequestStatus.FOUND) throw new Error("REQUEST_ALREADY_FOUND");
        if (existing?.status === ReplacementRequestStatus.FAILED) throw new Error("REQUEST_PREVIOUSLY_FAILED");

        let awsReplacementPublicId: string | null = null;
        if (AWS_REPLACEMENTS_CANONICAL_ENABLED) {
            const canonicalResult = await startCanonicalReplacement({
                workShiftId: shift.id,
                requesterStaffId,
                requesterTelegramId: String(shift.staff.user.telegramId),
                locationId: shift.locationId,
                shiftDate: shift.date,
            });
            if (!canonicalResult.ok) {
                throw new Error(`CANONICAL_REPLACEMENT_FAILED:${canonicalResult.reasonCode}`);
            }
            awsReplacementPublicId = canonicalResult.replacementPublicId;
        }

        const request = await this.createActiveRequest({
            workShiftId: shift.id,
            requesterStaffId,
            locationId: shift.locationId,
            city: shift.location.city,
            shiftDate: shift.date,
            shiftStartTime: shift.startTime,
            shiftEndTime: shift.endTime,
            awsReplacementPublicId,
        });

        await this.notifyAdminStarted(api, request.id);
        await this.dispatchNextWave(api, request.id);
        return request;
    }

    async listManualSearchDateOptions(locationId: string, daysAhead: number = 14) {
        const location = await prisma.location.findUnique({ where: { id: locationId } });
        if (!location) return [];

        const start = this.kyivStartOfDay(new Date());
        const end = new Date(start.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        const [shifts, activeRequests] = await Promise.all([
            prisma.workShift.findMany({
                where: { locationId, date: { gte: start, lt: end } },
                select: { date: true }
            }),
            prisma.replacementRequest.findMany({
                where: { locationId, status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES }, shiftDate: { gte: start, lt: end } },
                select: { shiftDate: true }
            })
        ]);

        const scheduledDates = new Set(shifts.map(shift => this.formatDateKey(shift.date)));
        const blockedSearchDates = new Set(activeRequests.map(request => this.formatDateKey(request.shiftDate)));

        return Array.from({ length: daysAhead }, (_, index) => {
            const date = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
            const dateKey = this.formatDateKey(date);
            const shiftStartAt = this.getShiftStartAt({ shiftDate: date, location });
            return {
                date,
                dateKey,
                label: `${this.formatDate(date)} · ${this.formatShiftTime({ shiftDate: date, location })}`,
                hasShift: scheduledDates.has(dateKey),
                hasActiveSearch: blockedSearchDates.has(dateKey),
                hasStarted: shiftStartAt <= new Date(),
            };
        }).filter(option => !option.hasShift && !option.hasActiveSearch && !option.hasStarted);
    }

    async startAdminRequest(api: Api, locationId: string, shiftDate: Date) {
        const location = await prisma.location.findUnique({ where: { id: locationId } });
        if (!location) throw new Error("LOCATION_NOT_FOUND");

        const dayStart = this.kyivStartOfDay(shiftDate);
        const dayEnd = this.nextKyivDay(shiftDate);
        const shiftTimes = this.getShiftTimeDates(dayStart, location);
        const shiftStartAt = shiftTimes.start ?? this.getShiftStartAt({ shiftDate: dayStart, location });
        if (shiftStartAt <= new Date()) throw new Error("SHIFT_ALREADY_STARTED");

        const existingShift = await prisma.workShift.findFirst({
            where: { locationId, date: { gte: dayStart, lt: dayEnd } }
        });
        if (existingShift) throw new Error("LOCATION_DAY_ALREADY_HAS_SHIFT");

        const existingRequest = await prisma.replacementRequest.findFirst({
            where: { locationId, status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES }, shiftDate: { gte: dayStart, lt: dayEnd } }
        });
        if (existingRequest?.status === ReplacementRequestStatus.ACTIVE) throw new Error("REQUEST_ALREADY_ACTIVE");
        if (existingRequest?.status === ReplacementRequestStatus.FOUND) throw new Error("REQUEST_ALREADY_FOUND");
        if (existingRequest?.status === ReplacementRequestStatus.FAILED) throw new Error("REQUEST_PREVIOUSLY_FAILED");

        const request = await this.createActiveRequest({
            locationId,
            city: location.city,
            shiftDate: dayStart,
            shiftStartTime: shiftTimes.start,
            shiftEndTime: shiftTimes.end,
        });

        await this.notifyAdminStarted(api, request.id);
        await this.dispatchNextWave(api, request.id);
        return request;
    }

    private async createActiveRequest(data: Prisma.ReplacementRequestUncheckedCreateInput) {
        try {
            return await prisma.replacementRequest.create({ data });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new Error("REQUEST_ALREADY_ACTIVE");
            }
            throw error;
        }
    }

    async cancelRequest(api: Api, requesterStaffId: string, requestId: string) {
        const updated = await prisma.replacementRequest.updateMany({
            where: {
                id: requestId,
                requesterStaffId,
                status: ReplacementRequestStatus.ACTIVE
            },
            data: {
                status: ReplacementRequestStatus.CANCELLED,
                completedAt: new Date(),
                closedReason: "cancelled_by_author"
            }
        });

        if (updated.count === 0) return false;

        const request = await this.getRequest(requestId);
        if (request) {
            await this.inactivateOpenResponses(api, request.id, this.formatClosedCandidateText(request));
            await this.notifyAdminCancelled(api, request.id);
        }

        return true;
    }

    async cancelRequestByAdmin(api: Api, requestId: string) {
        const updated = await prisma.replacementRequest.updateMany({
            where: {
                id: requestId,
                status: ReplacementRequestStatus.ACTIVE
            },
            data: {
                status: ReplacementRequestStatus.CANCELLED,
                completedAt: new Date(),
                closedReason: "cancelled_by_admin",
                nextWaveAt: null
            }
        });

        if (updated.count === 0) return false;

        const request = await this.getRequest(requestId);
        if (request) {
            if (request.requester) {
                await api.sendMessage(
                    Number(request.requester.user.telegramId),
                    "Пошук підміни скасовано адміністратором.\nЯкщо питання ще актуальне, напиши в підтримку.",
                    {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().text("🤍 Написати в сапорт", "open_support_dialog")
                    }
                ).catch((err) => logger.warn({ err, requestId }, "Requester replacement admin-cancel notification failed"));
            }
            await this.inactivateOpenResponses(api, request.id, this.formatClosedCandidateText(request));
        }

        return true;
    }

    async cancelConfirmedRequestByAdmin(api: Api, requestId: string) {
        const request = await this.getRequest(requestId);
        if (
            !request
            || request.status !== ReplacementRequestStatus.FOUND
            || !request.replacementStaffId
            || !request.replacement
        ) {
            return "not_found" as const;
        }

        const replacementIsStillScheduled = await prisma.workShift.count({
            where: {
                staffId: request.replacementStaffId,
                locationId: request.locationId,
                date: {
                    gte: this.kyivStartOfDay(request.shiftDate),
                    lt: this.nextKyivDay(request.shiftDate)
                }
            }
        });
        if (replacementIsStillScheduled > 0) {
            return "replacement_still_scheduled" as const;
        }

        const updated = await prisma.replacementRequest.updateMany({
            where: {
                id: requestId,
                status: ReplacementRequestStatus.FOUND,
                replacementStaffId: request.replacementStaffId
            },
            data: {
                status: ReplacementRequestStatus.CANCELLED,
                closedReason: "accepted_replacement_cancelled_by_admin",
                nextWaveAt: null
            }
        });
        if (updated.count !== 1) return "not_found" as const;

        const details = this.formatShiftDetails(request);
        const replacementText = STAFF_TEXTS["staff-replacement-confirmed-cancelled-acceptor"]({ details });
        const acceptedResponse = await prisma.replacementResponse.findUnique({
            where: {
                requestId_staffId: {
                    requestId,
                    staffId: request.replacementStaffId
                }
            }
        });

        if (acceptedResponse) {
            await this.editCandidateMessage(api, acceptedResponse, replacementText, "closed");
        }

        await api.sendMessage(
            Number(request.replacement.user.telegramId),
            replacementText,
            { parse_mode: "HTML" }
        ).catch((err) => logger.warn({ err, requestId }, "Confirmed replacement admin-cancel notification failed"));

        if (request.requester) {
            await api.sendMessage(
                Number(request.requester.user.telegramId),
                STAFF_TEXTS["staff-replacement-confirmed-cancelled-requester"],
                { parse_mode: "HTML" }
            ).catch((err) => logger.warn({ err, requestId }, "Requester confirmed-replacement cancellation notification failed"));
        }

        await this.inactivateOpenResponses(
            api,
            requestId,
            this.formatClosedCandidateText({
                ...request,
                status: ReplacementRequestStatus.CANCELLED
            })
        );

        return "cancelled" as const;
    }

    async accept(api: Api, staffId: string, requestId: string) {
        const response = await prisma.replacementResponse.findUnique({
            where: { requestId_staffId: { requestId, staffId } },
            include: { request: { include: { location: true, requester: { include: { user: true } } } }, staff: { include: { user: true } } }
        });

        if (!response) return "not_found" as const;
        if (response.status === ReplacementResponseStatus.ACCEPTED) {
            await this.editCandidateMessage(
                api,
                response,
                this.formatAcceptedReplacementText(response.request),
                "accepted"
            );
            return "already_answered" as const;
        }
        if (response.request.status !== ReplacementRequestStatus.ACTIVE) {
            await this.editCandidateMessage(
                api,
                response,
                this.formatClosedCandidateText(response.request),
                "closed"
            );
            return "closed" as const;
        }
        if (response.status !== ReplacementResponseStatus.SENT) {
            await this.editCandidateMessage(api, response, this.formatAnsweredCandidateText(response.status), "answered");
            return "already_answered" as const;
        }

        const hasConflict = await this.hasShiftConflictOnDate(staffId, response.request.shiftDate, requestId);
        if (hasConflict) return "conflict" as const;

        const acceptance = await prisma.$transaction(async (tx) => {
            const reqUpdate = await tx.replacementRequest.updateMany({
                where: {
                    id: requestId,
                    status: ReplacementRequestStatus.ACTIVE,
                    replacementStaffId: null
                },
                data: {
                    status: ReplacementRequestStatus.FOUND,
                    replacementStaffId: staffId,
                    completedAt: new Date(),
                    closedReason: "accepted_by_candidate",
                    nextWaveAt: null
                }
            });

            if (reqUpdate.count !== 1) {
                return { accepted: false as const, otherResponses: [] as ReplacementMessageRef[] };
            }

            // Capture message references before changing the statuses. Telegram edits
            // happen after the transaction, but must use this pre-update snapshot.
            const otherResponses = await tx.replacementResponse.findMany({
                where: {
                    requestId,
                    id: { not: response.id },
                    status: ReplacementResponseStatus.SENT
                },
                select: {
                    id: true,
                    requestId: true,
                    chatId: true,
                    messageId: true
                }
            });

            await tx.replacementResponse.update({
                where: { id: response.id },
                data: {
                    status: ReplacementResponseStatus.ACCEPTED,
                    respondedAt: new Date()
                }
            });

            await tx.replacementResponse.updateMany({
                where: {
                    requestId,
                    id: { not: response.id },
                    status: ReplacementResponseStatus.SENT
                },
                data: { status: ReplacementResponseStatus.INACTIVE }
            });

            return { accepted: true as const, otherResponses };
        });

        if (!acceptance.accepted) {
            const latestRequest = await this.getRequest(requestId);
            await this.editCandidateMessage(
                api,
                response,
                this.formatClosedCandidateText(latestRequest ?? response.request),
                "closed"
            );
            return "closed" as const;
        }

        await this.editCandidateMessage(
            api,
            response,
            this.formatAcceptedReplacementText(response.request),
            "accepted"
        );

        await api.sendMessage(
            Number(response.staff.user.telegramId),
            this.formatAcceptedReplacementText(response.request),
            { parse_mode: "HTML" }
        ).catch((err) => logger.warn({ err, requestId, staffId }, "Replacement confirmation delivery failed"));

        await this.inactivateOtherSameDayOffersForStaff(api, staffId, response.request.shiftDate, requestId);

        const closedText = this.formatClosedCandidateText({
            ...response.request,
            status: ReplacementRequestStatus.FOUND
        });
        await Promise.all([
            this.notifyRequesterFound(api, response.request),
            this.notifyAdminFound(api, requestId),
            ...acceptance.otherResponses.map(otherResponse =>
                this.editCandidateMessage(api, otherResponse, closedText, "closed")
            )
        ]);

        return "accepted" as const;
    }

    async decline(api: Api, staffId: string, requestId: string) {
        const response = await prisma.replacementResponse.findUnique({
            where: { requestId_staffId: { requestId, staffId } },
            include: { request: { include: { location: true } } }
        });

        if (!response) return "not_found" as const;
        if (response.status === ReplacementResponseStatus.DECLINED) {
            await this.editCandidateMessage(api, response, "Дякуємо за відповідь.", "declined");
            return "already_answered" as const;
        }
        if (response.request.status !== ReplacementRequestStatus.ACTIVE) {
            await this.editCandidateMessage(
                api,
                response,
                this.formatClosedCandidateText(response.request),
                "closed"
            );
            return "closed" as const;
        }
        if (response.status !== ReplacementResponseStatus.SENT) {
            await this.editCandidateMessage(api, response, this.formatAnsweredCandidateText(response.status), "answered");
            return "already_answered" as const;
        }

        await prisma.replacementResponse.update({
            where: { id: response.id },
            data: {
                status: ReplacementResponseStatus.DECLINED,
                respondedAt: new Date()
            }
        });

        await this.editCandidateMessage(api, response, "Дякуємо за відповідь.", "declined");

        const remaining = await prisma.replacementResponse.count({
            where: {
                requestId,
                wave: response.wave,
                status: ReplacementResponseStatus.SENT
            }
        });
        if (remaining === 0) {
            await this.dispatchNextWave(api, requestId);
        }

        return "declined" as const;
    }

    async dispatchNextWave(api: Api, requestId: string) {
        const request = await this.getRequest(requestId);
        if (!request || request.status !== ReplacementRequestStatus.ACTIVE) return;

        if (await this.isRequestObsoleteAfterScheduleChange(request)) {
            await this.closeByScheduleSync(api, request, ReplacementRequestStatus.ACTIVE);
            return;
        }

        const now = new Date();
        if (this.getShiftStartAt(request) <= now) {
            await this.failRequest(api, request.id, ReplacementRequestStatus.EXPIRED, "shift_started");
            return;
        }

        /**
         * Candidate selection belongs to the canonical backend for any request it
         * knows about. It owns the wave policy, picks who to ask, records an OFFER
         * per candidate, and paces the next wave; the notification dispatcher then
         * delivers those offers. Running the local selector as well would message
         * photographers the backend never chose, leaving the two sides disagreeing
         * about who was even asked.
         *
         * Requests created before the switchover carry no `awsReplacementPublicId`
         * and stay on the local path to the end. Cancelling them mid-search would
         * strand photographers who are already deciding, so the two paths coexist
         * until the last legacy request closes.
         */
        if (request.awsReplacementPublicId) {
            await this.dispatchCanonicalNextWave(request.id, request.awsReplacementPublicId);
            return;
        }

        const previousWave = request.currentWave;
        if (previousWave && request.nextWaveAt && request.nextWaveAt > now) return;

        const nextWave = await this.findNextWave(request);
        if (!nextWave) {
            await this.failRequest(api, request.id, ReplacementRequestStatus.FAILED, "all_waves_completed");
            return;
        }

        const candidates = await this.findCandidatesForWave(request, nextWave);
        if (candidates.length === 0) {
            await prisma.replacementRequest.update({
                where: { id: request.id },
                data: { currentWave: nextWave, nextWaveAt: now }
            });
            await defaultQueue.add(
                "replacement-dispatch-wave",
                { requestId: request.id },
                { delay: 60_000, attempts: 3, backoff: { type: "fixed", delay: 60_000 }, removeOnComplete: true }
            );
            return;
        }

        const intervalMs = this.getIntervalMs(request);
        const nextWaveAt = await this.getNextWaveAtAfterDispatch(request, nextWave, now, intervalMs);

        await prisma.replacementRequest.update({
            where: { id: request.id },
            data: { currentWave: nextWave, nextWaveAt }
        });

        await this.sendWave(api, request, nextWave, candidates);

        await defaultQueue.add(
            "replacement-dispatch-wave",
            { requestId: request.id },
            {
                delay: Math.max(0, nextWaveAt.getTime() - now.getTime()),
                attempts: 3,
                backoff: { type: "fixed", delay: 60_000 },
                removeOnComplete: true
            }
        );
    }

    /**
     * Runs one canonical wave and schedules the next poll from the time the
     * backend reported.
     *
     * No candidates are selected, no messages are sent and no wave state is
     * written locally: the backend records the offers and an OFFER notification
     * for each, which the notification dispatcher delivers on its own loop.
     * Keeping a second wave clock here is what would let the two sides disagree
     * about when a wave is due — so `nextWaveAt` is taken as given.
     *
     * A `null` due time means the backend has stopped pacing this request
     * (found, cancelled, expired) and polling must stop with it. An outage
     * reschedules the same canonical dispatch rather than falling back to local
     * selection, which would offer the shift to people it has no record of.
     */
    private async dispatchCanonicalNextWave(requestId: string, replacementPublicId: string) {
        const result = await dispatchCanonicalWave(replacementPublicId);

        const delay = result.ok
            ? result.nextWaveAt === null
                ? null
                : Math.max(0, result.nextWaveAt.getTime() - Date.now())
            : CANONICAL_WAVE_RETRY_MS;
        if (delay === null) return;

        await defaultQueue.add(
            "replacement-dispatch-wave",
            { requestId },
            {
                delay,
                attempts: 3,
                backoff: { type: "fixed", delay: 60_000 },
                removeOnComplete: true
            }
        );
    }

    async reconcileRequestsChangedBySchedule(api: Api) {
        const requests = await prisma.replacementRequest.findMany({
            where: {
                OR: [
                    { status: ReplacementRequestStatus.ACTIVE },
                    {
                        status: ReplacementRequestStatus.FOUND,
                        shiftDate: { gte: this.kyivStartOfDay(new Date()) }
                    }
                ]
            },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } }
            }
        });

        for (const request of requests) {
            if (request.status === ReplacementRequestStatus.FOUND) {
                if (!request.replacementStaffId) continue;

                const dateRange = {
                    gte: this.kyivStartOfDay(request.shiftDate),
                    lt: this.nextKyivDay(request.shiftDate)
                };
                const scheduledShifts = await prisma.workShift.findMany({
                    where: {
                        date: dateRange,
                        OR: [
                            { locationId: request.locationId },
                            { staffId: request.replacementStaffId }
                        ]
                    },
                    select: {
                        id: true,
                        staffId: true,
                        locationId: true,
                        date: true
                    }
                });

                if (classifyAcceptedReplacement(request, scheduledShifts) === "superseded") {
                    await this.closeByScheduleSync(api, request, ReplacementRequestStatus.FOUND);
                }
                continue;
            }

            if (!request.requesterStaffId) {
                const locationShift = await prisma.workShift.findFirst({
                    where: {
                        locationId: request.locationId,
                        date: { gte: this.kyivStartOfDay(request.shiftDate), lt: this.nextKyivDay(request.shiftDate) }
                    }
                });
                if (locationShift) {
                    await this.closeByScheduleSync(api, request, ReplacementRequestStatus.ACTIVE);
                }
                continue;
            }

            const currentShift = await this.findSameScheduledShift(request);
            if (!currentShift) {
                await this.closeByScheduleSync(api, request, ReplacementRequestStatus.ACTIVE);
            } else if (request.workShiftId !== currentShift.id) {
                await prisma.replacementRequest.update({
                    where: { id: request.id },
                    data: { workShiftId: currentShift.id }
                });
            }
        }
    }

    async processOverdueActiveRequests(api: Api) {
        const now = new Date();
        const overdue = await prisma.replacementRequest.findMany({
            where: {
                status: ReplacementRequestStatus.ACTIVE,
                OR: [
                    { nextWaveAt: { lte: now } },
                    { shiftDate: { lt: this.kyivStartOfDay(now) } }
                ]
            },
            select: { id: true },
            orderBy: [
                { shiftDate: "asc" },
                { createdAt: "asc" }
            ],
            take: 25
        });

        for (const request of overdue) {
            await this.dispatchNextWave(api, request.id).catch((err) => {
                logger.warn({ err, requestId: request.id }, "Overdue replacement request recovery failed");
            });
        }
    }

    private async findNextWave(request: RequestWithRelations): Promise<ReplacementSearchWave | null> {
        const sequence = await this.getWaveSequence(request);
        const sentWaves = await prisma.replacementResponse.findMany({
            where: { requestId: request.id },
            select: { wave: true },
            distinct: ["wave"]
        });
        const used = new Set(sentWaves.map(r => r.wave));
        if (request.currentWave) used.add(request.currentWave);
        return sequence.find(wave => !used.has(wave)) ?? null;
    }

    private async getWaveSequence(request: RequestWithRelations): Promise<ReplacementSearchWave[]> {
        if (this.getShiftStartAt(request).getTime() - Date.now() <= URGENT_THRESHOLD_MS) {
            return [ReplacementSearchWave.URGENT_ALL];
        }

        const locationCount = await prisma.location.count({
            where: { city: request.city, isHidden: false }
        });

        const sameLocation = [
            ReplacementSearchWave.SAME_LOCATION_AVAILABLE,
            ReplacementSearchWave.SAME_LOCATION_LIMITED,
        ];

        if (locationCount <= 1) return sameLocation;

        return [
            ...sameLocation,
            ReplacementSearchWave.SAME_CITY_AVAILABLE,
            ReplacementSearchWave.SAME_CITY_LIMITED,
        ];
    }

    private async findCandidatesForWave(request: RequestWithRelations, wave: ReplacementSearchWave) {
        const availability = await scheduleAvailabilityService.getAvailabilityForDateFromSchedule(request.shiftDate);
        const kindByStaff = new Map<string, ReplacementAvailabilityKind>();
        for (const [staffId, kind] of availability.entries()) {
            kindByStaff.set(staffId, kind === "available" ? ReplacementAvailabilityKind.AVAILABLE : ReplacementAvailabilityKind.LIMITED);
        }

        const desiredKinds = this.getDesiredAvailabilityKinds(wave);
        const staffIdsWithDesiredAvailability = [...kindByStaff.entries()]
            .filter(([, kind]) => desiredKinds.includes(kind))
            .map(([staffId]) => staffId);

        if (staffIdsWithDesiredAvailability.length === 0) return [];

        const candidates = await prisma.staffProfile.findMany({
            where: {
                id: request.requesterStaffId
                    ? { in: staffIdsWithDesiredAvailability, not: request.requesterStaffId }
                    : { in: staffIdsWithDesiredAvailability },
                isActive: true,
                user: { botBlockedAt: null },
                ...this.getLocationFilter(request, wave)
            },
            include: { user: true, location: true },
            orderBy: { fullName: "asc" }
        }) as StaffWithUserLocation[];

        const candidateIds = candidates.map(c => c.id);
        const [busyShifts, acceptedAssignments, existingResponses] = await Promise.all([
            prisma.workShift.findMany({
                where: {
                    staffId: { in: candidateIds },
                    date: { gte: this.kyivStartOfDay(request.shiftDate), lt: this.nextKyivDay(request.shiftDate) }
                },
                select: { staffId: true }
            }),
            prisma.replacementRequest.findMany({
                where: {
                    id: { not: request.id },
                    replacementStaffId: { in: candidateIds },
                    status: ReplacementRequestStatus.FOUND,
                    shiftDate: { gte: this.kyivStartOfDay(request.shiftDate), lt: this.nextKyivDay(request.shiftDate) }
                },
                select: { replacementStaffId: true }
            }),
            prisma.replacementResponse.findMany({
                where: {
                    staffId: { in: candidateIds },
                    status: { in: CONTACTED_RESPONSE_STATUSES },
                    request: this.getSameReplacementSearchFilter(request)
                },
                select: { staffId: true }
            })
        ]);

        const busy = new Set([
            ...busyShifts.map(s => s.staffId),
            ...acceptedAssignments.flatMap(assignment => assignment.replacementStaffId ? [assignment.replacementStaffId] : [])
        ]);
        const alreadyAsked = new Set(existingResponses.map(r => r.staffId));

        const result = candidates
            .filter(candidate => !busy.has(candidate.id) && !alreadyAsked.has(candidate.id))
            .map(candidate => ({ staff: candidate, availabilityKind: kindByStaff.get(candidate.id)! }));

        const requesterTelegramId = request.requester?.user?.telegramId;
        if (requesterTelegramId) {
            replacementShadowService.compareInBackground({
                requestId: request.id,
                workShiftId: request.workShiftId,
                requesterStaffId: request.requesterStaffId,
                requesterTelegramId: String(requesterTelegramId),
                locationId: request.locationId,
                shiftDate: request.shiftDate,
                legacyCandidates: result.map(candidate => ({
                    awsEmployeePublicId: candidate.staff.awsEmployeePublicId,
                    availabilityKind: candidate.availabilityKind,
                })),
                wave,
            });
        }

        return result;
    }

    private getSameReplacementSearchFilter(request: RequestWithRelations) {
        const sameSearchFilters: Prisma.ReplacementRequestWhereInput[] = [{ id: request.id }];
        if (request.workShiftId) {
            sameSearchFilters.push({ workShiftId: request.workShiftId });
        }
        if (request.requesterStaffId) {
            sameSearchFilters.push({
                requesterStaffId: request.requesterStaffId,
                locationId: request.locationId,
                shiftDate: {
                    gte: this.kyivStartOfDay(request.shiftDate),
                    lt: this.nextKyivDay(request.shiftDate)
                }
            });
        } else {
            sameSearchFilters.push({
                workShiftId: null,
                locationId: request.locationId,
                shiftDate: {
                    gte: this.kyivStartOfDay(request.shiftDate),
                    lt: this.nextKyivDay(request.shiftDate)
                }
            });
        }
        return { OR: sameSearchFilters };
    }

    private getDesiredAvailabilityKinds(wave: ReplacementSearchWave): ReplacementAvailabilityKind[] {
        if (wave === ReplacementSearchWave.SAME_LOCATION_AVAILABLE || wave === ReplacementSearchWave.SAME_CITY_AVAILABLE) {
            return [ReplacementAvailabilityKind.AVAILABLE];
        }
        if (wave === ReplacementSearchWave.SAME_LOCATION_LIMITED || wave === ReplacementSearchWave.SAME_CITY_LIMITED) {
            return [ReplacementAvailabilityKind.LIMITED];
        }
        return [ReplacementAvailabilityKind.AVAILABLE, ReplacementAvailabilityKind.LIMITED];
    }

    private getLocationFilter(request: RequestWithRelations, wave: ReplacementSearchWave) {
        if (wave === ReplacementSearchWave.SAME_LOCATION_AVAILABLE || wave === ReplacementSearchWave.SAME_LOCATION_LIMITED) {
            return { locationId: request.locationId };
        }
        if (wave === ReplacementSearchWave.SAME_CITY_AVAILABLE || wave === ReplacementSearchWave.SAME_CITY_LIMITED) {
            return { location: { city: request.city }, locationId: { not: request.locationId } };
        }
        return { location: { city: request.city } };
    }

    private async sendWave(
        api: Api,
        request: RequestWithRelations,
        wave: ReplacementSearchWave,
        candidates: Array<{ staff: StaffWithUserLocation; availabilityKind: ReplacementAvailabilityKind }>
    ) {
        for (const candidate of candidates) {
            const response = await prisma.replacementResponse.create({
                data: {
                    requestId: request.id,
                    staffId: candidate.staff.id,
                    wave,
                    availabilityKind: candidate.availabilityKind
                }
            });

            const text = this.buildCandidateText(request, candidate.availabilityKind);
            const keyboard = new InlineKeyboard()
                .text("Можу вийти", `staff_repl_accept_${request.id}`).row()
                .text("Не можу", `staff_repl_decline_${request.id}`).danger();

            try {
                const sent = await api.sendMessage(Number(candidate.staff.user.telegramId), text, {
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
                await prisma.replacementResponse.update({
                    where: { id: response.id },
                    data: {
                        chatId: BigInt(sent.chat.id),
                        messageId: sent.message_id
                    }
                });
            } catch (err: any) {
                logger.warn({ err, requestId: request.id, staffId: candidate.staff.id }, "Replacement request delivery failed");
                await prisma.replacementResponse.update({
                    where: { id: response.id },
                    data: {
                        status: ReplacementResponseStatus.DELIVERY_FAILED,
                        deliveryError: err?.message || String(err)
                    }
                });
            }
        }

        const liveResponses = await prisma.replacementResponse.count({
            where: { requestId: request.id, wave, status: ReplacementResponseStatus.SENT }
        });
        if (liveResponses === 0) {
            await this.dispatchNextWave(api, request.id);
        }
    }

    private buildCandidateText(request: RequestWithRelations, availabilityKind: ReplacementAvailabilityKind) {
        const shift = this.formatShiftDetails(request);
        if (availabilityKind === ReplacementAvailabilityKind.LIMITED) {
            return `Є запит на підміну.\nВи вказували, що цей день незручний, але якщо плани змінились, можете відгукнутися.\n\n${shift}`;
        }

        return `Чи можете вийти на підміну?\n\n${shift}`;
    }

    private formatAcceptedReplacementText(request: RequestWithRelations) {
        return STAFF_TEXTS["staff-replacement-accepted"]({ details: this.formatShiftDetails(request) });
    }

    private formatClosedCandidateText(request: RequestWithRelations) {
        const details = this.formatShiftDetails(request);

        switch (request.status) {
            case ReplacementRequestStatus.FOUND:
                return `Підміну вже знайдено.\nДякуємо, що відгукнулися.\n\n${details}`;
            case ReplacementRequestStatus.CANCELLED:
                return `Пошук підміни скасовано.\n\n${details}`;
            case ReplacementRequestStatus.EXPIRED:
                return `Пошук завершено: зміна вже почалася.\n\n${details}`;
            case ReplacementRequestStatus.CLOSED_BY_SCHEDULE_SYNC:
                return `Пошук закрито: графік уже оновлено.\n\n${details}`;
            default:
                return `Пошук підміни завершено.\n\n${details}`;
        }
    }

    private formatAnsweredCandidateText(status: ReplacementResponseStatus) {
        if (status === ReplacementResponseStatus.DECLINED) return "Дякуємо за відповідь.";
        if (status === ReplacementResponseStatus.ACCEPTED) return "Дякуємо. Підміну вже прийнято вами.";
        return "Ця пропозиція більше неактивна.";
    }

    private async notifyRequesterFound(api: Api, request: RequestWithRelations) {
        if (!request.requester) return;

        await api.sendMessage(Number(request.requester.user.telegramId), "Підміну знайдено.\nАдміністратор отримає деталі та оновить графік.", {
            parse_mode: "HTML"
        }).catch((err) => logger.warn({ err, requestId: request.id }, "Requester replacement-found notification failed"));
    }

    private async notifyAdminFound(api: Api, requestId: string) {
        const request = await prisma.replacementRequest.findUnique({
            where: { id: requestId },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } }
            }
        });
        if (!request?.replacement) return;

        const text = this.formatAdminNotification("found", request);

        await api.sendMessage(MAIN_ADMIN_ID, text, { parse_mode: "HTML" })
            .then(async () => {
                await prisma.replacementRequest.update({
                    where: { id: requestId },
                    data: { adminNotifiedAt: new Date() }
                });
            })
            .catch((err) => logger.warn({ err, requestId }, "Replacement admin notification failed"));
    }

    private async notifyAdminStarted(api: Api, requestId: string) {
        const request = await this.getRequest(requestId);
        if (!request) return;

        const text = this.formatAdminNotification("started", request);

        await api.sendMessage(MAIN_ADMIN_ID, text, { parse_mode: "HTML" })
            .catch((err) => logger.warn({ err, requestId }, "Replacement start admin notification failed"));
    }

    private async notifyAdminCancelled(api: Api, requestId: string) {
        const request = await this.getRequest(requestId);
        if (!request) return;

        const text = this.formatAdminNotification("cancelled", request);

        await api.sendMessage(MAIN_ADMIN_ID, text, { parse_mode: "HTML" })
            .catch((err) => logger.warn({ err, requestId }, "Replacement cancel admin notification failed"));
    }

    private async notifyAdminFailed(api: Api, requestId: string) {
        const request = await this.getRequest(requestId);
        if (!request) return;

        const text = this.formatAdminNotification("failed", request);

        await api.sendMessage(MAIN_ADMIN_ID, text, { parse_mode: "HTML" })
            .catch((err) => logger.warn({ err, requestId }, "Replacement failure admin notification failed"));
    }

    private async failRequest(api: Api, requestId: string, status: ReplacementRequestStatus, reason: string) {
        await prisma.replacementRequest.updateMany({
            where: { id: requestId, status: ReplacementRequestStatus.ACTIVE },
            data: {
                status,
                completedAt: new Date(),
                closedReason: reason,
                nextWaveAt: null
            }
        });

        const request = await this.getRequest(requestId);
        if (!request) return;

        if (request.requester) {
            await api.sendMessage(Number(request.requester.user.telegramId), this.formatRequesterFailureText(request), {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🤍 Написати в сапорт", "open_support_dialog")
            }).catch(() => { });
        }
        await this.notifyAdminFailed(api, requestId);
        await this.inactivateOpenResponses(api, requestId, this.formatClosedCandidateText(request));
    }

    private async closeByScheduleSync(
        api: Api,
        request: RequestWithRelations,
        expectedStatus: ReplacementRequestStatus
    ) {
        const wasAccepted = expectedStatus === ReplacementRequestStatus.FOUND;
        const result = await prisma.replacementRequest.updateMany({
            where: { id: request.id, status: expectedStatus },
            data: wasAccepted
                ? {
                    status: ReplacementRequestStatus.CLOSED_BY_SCHEDULE_SYNC,
                    closedReason: "accepted_replacement_superseded_by_schedule",
                    nextWaveAt: null
                }
                : {
                    status: ReplacementRequestStatus.CLOSED_BY_SCHEDULE_SYNC,
                    completedAt: new Date(),
                    closedReason: "schedule_changed",
                    nextWaveAt: null
                }
        });
        if (result.count !== 1) return;

        const closedRequest = {
            ...request,
            status: ReplacementRequestStatus.CLOSED_BY_SCHEDULE_SYNC
        };

        if (request.requester) {
            const requesterText = wasAccepted
                ? STAFF_TEXTS["staff-replacement-overridden-requester"]
                : "Пошук закрито.\nГрафік уже оновлено.";
            await api.sendMessage(Number(request.requester.user.telegramId), requesterText, {
                parse_mode: "HTML"
            }).catch(() => { });
        }

        if (wasAccepted && request.replacement) {
            await api.sendMessage(
                Number(request.replacement.user.telegramId),
                STAFF_TEXTS["staff-replacement-overridden-acceptor"]({
                    details: this.formatShiftDetails(request)
                }),
                { parse_mode: "HTML" }
            ).catch((err) => logger.warn({ err, requestId: request.id }, "Superseded replacement notification failed"));
        }

        await this.inactivateOpenResponses(
            api,
            request.id,
            this.formatClosedCandidateText(closedRequest)
        );
    }

    private async inactivateOpenResponses(api: Api, requestId: string, text: string, exceptResponseId?: string) {
        const responses = await prisma.replacementResponse.findMany({
            where: {
                requestId,
                status: ReplacementResponseStatus.SENT,
                ...(exceptResponseId ? { id: { not: exceptResponseId } } : {})
            }
        });

        await prisma.replacementResponse.updateMany({
            where: {
                id: { in: responses.map(r => r.id) }
            },
            data: { status: ReplacementResponseStatus.INACTIVE }
        });

        await Promise.all(responses.map(response => this.editCandidateMessage(api, response, text, "closed")));
    }

    private async inactivateOtherSameDayOffersForStaff(
        api: Api,
        staffId: string,
        shiftDate: Date,
        acceptedRequestId: string
    ) {
        const responses = await prisma.replacementResponse.findMany({
            where: {
                staffId,
                status: ReplacementResponseStatus.SENT,
                request: {
                    id: { not: acceptedRequestId },
                    status: ReplacementRequestStatus.ACTIVE,
                    shiftDate: { gte: this.kyivStartOfDay(shiftDate), lt: this.nextKyivDay(shiftDate) }
                }
            },
            include: { request: { include: { location: true } } }
        });

        if (responses.length === 0) return;

        await prisma.replacementResponse.updateMany({
            where: { id: { in: responses.map(response => response.id) } },
            data: {
                status: ReplacementResponseStatus.INACTIVE,
                respondedAt: new Date()
            }
        });

        await Promise.all(responses.map(response => this.editCandidateMessage(
            api,
            response,
            STAFF_TEXTS["staff-replacement-other-offer-closed"]({
                details: this.formatShiftDetails(response.request as RequestWithRelations)
            }),
            "closed"
        )));
    }

    private async editCandidateMessage(
        api: Api,
        response: ReplacementMessageRef,
        text: string,
        state: "accepted" | "declined" | "answered" | "closed"
    ) {
        if (!response.chatId || !response.messageId) {
            logger.warn({
                event: "staff.replacement.message_reconcile_skipped",
                request_id: response.requestId,
                response_id: response.id,
                state,
                result: "skipped",
                reason: "missing_message_reference"
            }, "Replacement message could not be reconciled");
            return false;
        }

        try {
            await api.editMessageText(Number(response.chatId), response.messageId, text, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] }
            });
            logger.info({
                event: "staff.replacement.message_reconciled",
                request_id: response.requestId,
                response_id: response.id,
                state,
                result: "success"
            }, "Replacement message reconciled");
            return true;
        } catch (err: any) {
            const description = String(err?.description ?? err?.message ?? "");
            if (description.toLowerCase().includes("message is not modified")) {
                logger.debug({
                    event: "staff.replacement.message_reconciled",
                    request_id: response.requestId,
                    response_id: response.id,
                    state,
                    result: "already_current"
                }, "Replacement message was already current");
                return true;
            }

            logger.warn({
                err,
                event: "staff.replacement.message_reconcile_failed",
                request_id: response.requestId,
                response_id: response.id,
                message_id: response.messageId,
                state,
                result: "failure"
            }, "Replacement message reconciliation failed");
            return false;
        }
    }

    private async isRequestObsoleteAfterScheduleChange(request: RequestWithRelations) {
        if (!request.requesterStaffId) {
            const locationShift = await prisma.workShift.findFirst({
                where: {
                    locationId: request.locationId,
                    date: {
                        gte: this.kyivStartOfDay(request.shiftDate),
                        lt: this.nextKyivDay(request.shiftDate)
                    }
                }
            });
            return Boolean(locationShift);
        }

        return !(await this.findSameScheduledShift(request));
    }

    private async findSameScheduledShift(request: RequestWithRelations) {
        if (!request.requesterStaffId) return null;

        return prisma.workShift.findFirst({
            where: {
                staffId: request.requesterStaffId,
                locationId: request.locationId,
                date: {
                    gte: this.kyivStartOfDay(request.shiftDate),
                    lt: this.nextKyivDay(request.shiftDate)
                }
            }
        });
    }

    private async hasShiftConflictOnDate(staffId: string, date: Date, currentRequestId: string) {
        const range = { gte: this.kyivStartOfDay(date), lt: this.nextKyivDay(date) };
        const [scheduledShiftCount, acceptedReplacementCount] = await Promise.all([
            prisma.workShift.count({
                where: { staffId, date: range }
            }),
            prisma.replacementRequest.count({
                where: {
                    id: { not: currentRequestId },
                    replacementStaffId: staffId,
                    status: ReplacementRequestStatus.FOUND,
                    shiftDate: range
                }
            })
        ]);
        return scheduledShiftCount > 0 || acceptedReplacementCount > 0;
    }

    private async getRequest(requestId: string): Promise<RequestWithRelations | null> {
        return prisma.replacementRequest.findUnique({
            where: { id: requestId },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } }
            }
        }) as Promise<RequestWithRelations | null>;
    }

    private getIntervalMs(request: RequestWithRelations) {
        const msUntilShift = this.getShiftStartAt(request).getTime() - Date.now();
        return msUntilShift > DAY_THRESHOLD_MS ? FOUR_HOURS_MS : ONE_HOUR_MS;
    }

    private async getNextWaveAtAfterDispatch(
        request: RequestWithRelations,
        wave: ReplacementSearchWave,
        now: Date,
        intervalMs: number
    ) {
        const sequence = await this.getWaveSequence(request);
        const normalNextAt = new Date(now.getTime() + intervalMs);
        if (sequence[sequence.length - 1] !== wave) return normalNextAt;

        const finalCloseAt = this.getShiftStartAt(request);
        return finalCloseAt > normalNextAt ? finalCloseAt : normalNextAt;
    }

    private getShiftStartAt(shift: { date?: Date; shiftDate?: Date; startTime?: Date | null; shiftStartTime?: Date | null; location?: Location }) {
        const date = shift.date ?? shift.shiftDate;
        if (!date) return new Date(0);
        const explicitStart = shift.startTime ?? shift.shiftStartTime;
        if (explicitStart) return explicitStart;
        const range = getShiftTimeFromLocationSchedule(shift.location?.schedule, date);
        const start = range?.match(/^(\d{1,2}):(\d{2})/);
        if (!start) return this.kyivStartOfDay(date);

        return this.kyivDateWithTime(date, parseInt(start[1]!), parseInt(start[2]!));
    }

    private getShiftTimeDates(date: Date, location: Location) {
        const range = getShiftTimeFromLocationSchedule(location.schedule, date);
        const match = range?.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
        if (!match) {
            return {
                start: null,
                end: null
            };
        }

        return {
            start: this.kyivDateWithTime(date, parseInt(match[1]!), parseInt(match[2]!)),
            end: this.kyivDateWithTime(date, parseInt(match[3]!), parseInt(match[4]!))
        };
    }

    private formatShiftDetails(request: RequestWithRelations) {
        return `${this.formatDate(request.shiftDate)}\n${escapeHtml(formatLocation(request.location, "in-city"))}\n${escapeHtml(this.formatShiftTime(request))}`;
    }

    private formatShiftTime(request: { shiftStartTime?: Date | null | undefined; shiftEndTime?: Date | null | undefined; shiftDate: Date; location?: Location }) {
        if (request.shiftStartTime && request.shiftEndTime) {
            return `${this.formatTime(request.shiftStartTime)}-${this.formatTime(request.shiftEndTime)}`;
        }
        return getShiftTimeFromLocationSchedule(request.location?.schedule, request.shiftDate) || "час не вказано";
    }

    formatShiftButtonLabel(shift: { date: Date; location: Location }) {
        return `${this.formatDate(shift.date)}, ${formatLocation(shift.location, "in-city")}`;
    }

    formatConfirmationText(shift: { date: Date; startTime?: Date | null; endTime?: Date | null; location: Location }) {
        const time = this.formatShiftTime({
            shiftDate: shift.date,
            shiftStartTime: shift.startTime,
            shiftEndTime: shift.endTime,
            location: shift.location
        });

        return `Потрібна підміна на цю зміну:\n${this.formatDate(shift.date)}\n${escapeHtml(formatLocation(shift.location, "in-city"))}\n${escapeHtml(time)}\n\nПочати пошук?`;
    }

    formatAdminBoardText(requests: Awaited<ReturnType<ReplacementService["listManageableRequestsForAdmin"]>>) {
        if (requests.length === 0) {
            return "🔎 <b>Replacement management</b>\n\nNo active or confirmed replacements.";
        }

        const visibleRequests = requests.slice(0, 8);
        const activeCount = requests.filter(request => request.status === ReplacementRequestStatus.ACTIVE).length;
        const confirmedCount = requests.filter(request => request.status === ReplacementRequestStatus.FOUND).length;
        let text = `🔎 <b>Replacement management</b>\n\nActive searches: <b>${activeCount}</b> · Confirmed: <b>${confirmedCount}</b>\n`;
        if (requests.length > visibleRequests.length) {
            text += `Showing first <b>${visibleRequests.length}</b>. Use Refresh after closing items.\n`;
        }

        visibleRequests.forEach((request, index) => {
            const sent = request.responses.filter((response) => response.status === ReplacementResponseStatus.SENT).length;
            const accepted = request.responses.filter((response) => response.status === ReplacementResponseStatus.ACCEPTED).length;
            const declined = request.responses.filter((response) => response.status === ReplacementResponseStatus.DECLINED).length;
            const failed = request.responses.filter((response) => response.status === ReplacementResponseStatus.DELIVERY_FAILED).length;
            const nextWave = request.nextWaveAt
                ? this.formatDateTime(request.nextWaveAt)
                : "not scheduled";
            const photographer = request.requester
                ? this.formatShortName(request.requester.fullName)
                : "empty shift (main admin)";
            const status = request.status === ReplacementRequestStatus.FOUND
                ? "✅ CONFIRMED"
                : "🔎 ACTIVE";
            const replacement = request.replacement
                ? ` → ${escapeHtml(this.formatShortName(request.replacement.fullName))}`
                : "";

            text +=
                `\n<b>${index + 1}. ${escapeHtml(formatLocation(request.location, "in-city"))}</b> · ${escapeHtml(request.city)} · ${status}\n` +
                `📅 ${this.formatDate(request.shiftDate)} · ${escapeHtml(this.formatShiftTime(request))}\n` +
                `👤 ${escapeHtml(photographer)}${replacement} · 🌊 <code>${escapeHtml(request.currentWave || "not started")}</code> · ⏭ ${escapeHtml(nextWave)}\n` +
                `📨 Responses: ${sent} pending / ${declined} declined / ${failed} failed / ${accepted} accepted\n`;
        });

        return text;
    }

    private formatAdminNotification(kind: "started" | "found" | "failed" | "cancelled", request: RequestWithRelations) {
        const titleByKind = {
            started: "🔁 <b>Replacement search started.</b>",
            found: "✅ <b>Replacement found.</b>",
            failed: "⚠️ <b>Replacement not found.</b>",
            cancelled: "🛑 <b>Replacement search cancelled.</b>"
        };
        const actionByKind = {
            started: "The request is open. Search waves will run automatically; monitor it and help manually if needed.",
            found: "Please update the schedule manually and sync the changes.",
            failed: "All available search waves finished without a result. Please contact the photographer and resolve manually.",
            cancelled: "The photographer cancelled this request. If they restart later, a new search request will be opened."
        };

        const replacementLine = request.replacement
            ? `\n✅ Replacement photographer: ${escapeHtml(this.formatShortName(request.replacement.fullName))}`
            : "";
        const requesterLine = request.requester
            ? `👤 Photographer: ${escapeHtml(this.formatShortName(request.requester.fullName))}${replacementLine}`
            : `👤 Photographer: <i>empty shift, started by main admin</i>${replacementLine}`;

        return (
            `${titleByKind[kind]}\n\n` +
            `<b>Shift</b>\n` +
            `📅 Date: <b>${this.formatDate(request.shiftDate)}</b>\n` +
            `🕒 Time: <b>${escapeHtml(this.formatShiftTime(request))}</b>\n` +
            `📍 Location: <b>${escapeHtml(formatLocation(request.location, "in-city"))}</b>\n` +
            `🏙 City: ${escapeHtml(request.city)}\n\n` +
            `<b>People</b>\n` +
            `${requesterLine}\n\n` +
            `<b>Next step</b>\n` +
            `${actionByKind[kind]}`
        );
    }

    private formatRequesterFailureText(request: RequestWithRelations) {
        return (
            `Поки що підміну не знайдено.\n\n` +
            `📅 <b>${this.formatDate(request.shiftDate)}</b>\n` +
            `🕒 <b>${escapeHtml(this.formatShiftTime(request))}</b>\n` +
            `📍 <b>${escapeHtml(formatLocation(request.location, "in-city"))}</b>\n\n` +
            `Будь ласка, напиши в підтримку, щоб адміністратор допоміг вирішити ситуацію вручну.`
        );
    }

    private formatDate(date: Date) {
        return date.toLocaleDateString("uk-UA", {
            day: "numeric",
            month: "long",
            timeZone: KYIV_TIMEZONE
        });
    }

    private formatTime(date: Date) {
        return date.toLocaleTimeString("uk-UA", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: KYIV_TIMEZONE
        });
    }

    private formatDateTime(date: Date) {
        return date.toLocaleString("uk-UA", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: KYIV_TIMEZONE
        });
    }

    private formatDateKey(date: Date) {
        return date.toLocaleDateString("en-CA", { timeZone: KYIV_TIMEZONE });
    }

    private formatShortName(fullName: string) {
        return fullName.trim().split(/\s+/).slice(0, 2).join(" ");
    }

    private kyivStartOfDay(date: Date) {
        return sharedKyivStartOfDay(date);
    }

    private nextKyivDay(date: Date) {
        return sharedNextKyivDay(date);
    }

    private kyivDateWithTime(date: Date, hour: number, minute: number) {
        const start = this.kyivStartOfDay(date);
        const rough = new Date(start.getTime() + hour * 60 * 60 * 1000 + minute * 60 * 1000);
        const offsetMinutes = this.getKyivUtcOffsetMinutes(rough);
        return new Date(rough.getTime() - offsetMinutes * 60 * 1000);
    }

    private getKyivUtcOffsetMinutes(date: Date): number {
        const utcMs = new Date(date.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
        const kyivMs = new Date(date.toLocaleString("en-US", { timeZone: KYIV_TIMEZONE })).getTime();
        return (kyivMs - utcMs) / 60000;
    }
}

export const replacementService = new ReplacementService();
