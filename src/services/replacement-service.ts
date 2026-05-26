import { InlineKeyboard, type Api } from "grammy";
import {
    ReplacementAvailabilityKind,
    ReplacementRequestStatus,
    ReplacementResponseStatus,
    ReplacementSearchWave,
    type Location,
    type ReplacementRequest,
    type StaffProfile,
    type User,
} from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { defaultQueue } from "../core/queue.js";
import { scheduleAvailabilityService } from "./schedule-availability-service.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";
import { escapeHtml } from "../handlers/admin/utils.js";

export const MAIN_ADMIN_ID = 107794048;
const KYIV_TIMEZONE = "Europe/Kyiv";
const URGENT_THRESHOLD_MS = 6 * 60 * 60 * 1000;
const DAY_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FINAL_WAVE_CLOSE_LEAD_MS = 4 * 60 * 60 * 1000;

type StaffWithUserLocation = StaffProfile & { user: User; location: Location | null };
type RequestWithRelations = ReplacementRequest & {
    location: Location;
    requester: StaffProfile & { user: User };
    replacement?: (StaffProfile & { user: User }) | null;
};

export class ReplacementService {
    async listActiveRequestsForAdmin() {
        return prisma.replacementRequest.findMany({
            where: { status: ReplacementRequestStatus.ACTIVE },
            include: {
                location: true,
                requester: { include: { user: true } },
                replacement: { include: { user: true } },
                responses: true
            },
            orderBy: [
                { shiftDate: "asc" },
                { createdAt: "asc" }
            ]
        });
    }

    async listSelectableShifts(staffId: string) {
        const today = this.kyivStartOfDay(new Date());
        return prisma.workShift.findMany({
            where: {
                staffId,
                date: { gte: today },
                replacementRequests: {
                    none: { status: ReplacementRequestStatus.ACTIVE }
                }
            },
            include: { location: true },
            orderBy: { date: "asc" },
            take: 12
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
                status: ReplacementRequestStatus.ACTIVE,
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
        if (existing) throw new Error("REQUEST_ALREADY_ACTIVE");

        const previouslyFailed = await prisma.replacementRequest.findFirst({
            where: {
                status: ReplacementRequestStatus.FAILED,
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
        if (previouslyFailed) throw new Error("REQUEST_PREVIOUSLY_FAILED");

        const request = await prisma.replacementRequest.create({
            data: {
                workShiftId: shift.id,
                requesterStaffId,
                locationId: shift.locationId,
                city: shift.location.city,
                shiftDate: shift.date,
                shiftStartTime: shift.startTime,
                shiftEndTime: shift.endTime,
            }
        });

        await this.notifyAdminStarted(api, request.id);
        await this.dispatchNextWave(api, request.id);
        return request;
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
            await this.inactivateOpenResponses(api, request.id, "Запит вже неактивний.\nПошук скасовано.");
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
            await api.sendMessage(
                Number(request.requester.user.telegramId),
                "Пошук підміни скасовано адміністратором.\nЯкщо питання ще актуальне, напиши в підтримку.",
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text("🤍 Написати в сапорт", "open_support_dialog")
                }
            ).catch((err) => logger.warn({ err, requestId }, "Requester replacement admin-cancel notification failed"));
            await this.inactivateOpenResponses(api, request.id, "Пошук підміни скасовано адміністратором.");
        }

        return true;
    }

    async accept(api: Api, staffId: string, requestId: string) {
        const response = await prisma.replacementResponse.findUnique({
            where: { requestId_staffId: { requestId, staffId } },
            include: { request: { include: { location: true, requester: { include: { user: true } } } }, staff: { include: { user: true } } }
        });

        if (!response) return "not_found" as const;
        if (response.status !== ReplacementResponseStatus.SENT) return "already_answered" as const;
        if (response.request.status !== ReplacementRequestStatus.ACTIVE) return "closed" as const;

        const hasConflict = await this.hasShiftOnDate(staffId, response.request.shiftDate);
        if (hasConflict) return "conflict" as const;

        const accepted = await prisma.$transaction(async (tx) => {
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

            if (reqUpdate.count !== 1) return false;

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

            return true;
        });

        if (!accepted) return "closed" as const;

        await this.editCandidateMessage(api, response.chatId, response.messageId, "Дякуємо. Ви прийняли підміну.\nАдміністратор отримає деталі.");
        await this.notifyRequesterFound(api, response.request);
        await this.notifyAdminFound(api, requestId);
        await this.inactivateOpenResponses(api, requestId, "Запит вже закрито.\nПідміну знайдено, дякуємо.", response.id);

        return "accepted" as const;
    }

    async decline(api: Api, staffId: string, requestId: string) {
        const response = await prisma.replacementResponse.findUnique({
            where: { requestId_staffId: { requestId, staffId } },
            include: { request: true }
        });

        if (!response) return "not_found" as const;
        if (response.status !== ReplacementResponseStatus.SENT) return "already_answered" as const;
        if (response.request.status !== ReplacementRequestStatus.ACTIVE) return "closed" as const;

        await prisma.replacementResponse.update({
            where: { id: response.id },
            data: {
                status: ReplacementResponseStatus.DECLINED,
                respondedAt: new Date()
            }
        });

        await this.editCandidateMessage(api, response.chatId, response.messageId, "Дякуємо за відповідь.");

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
            await this.closeByScheduleSync(api, request.id);
            return;
        }

        const now = new Date();
        if (this.getShiftStartAt(request) <= now) {
            await this.failRequest(api, request.id, ReplacementRequestStatus.EXPIRED, "shift_started");
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
            await this.dispatchNextWave(api, request.id);
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
            { delay: Math.max(0, nextWaveAt.getTime() - now.getTime()), attempts: 3, removeOnComplete: true }
        );
    }

    async closeActiveRequestsChangedBySchedule(api: Api) {
        const active = await prisma.replacementRequest.findMany({
            where: { status: ReplacementRequestStatus.ACTIVE },
            include: { location: true, requester: { include: { user: true } } }
        });

        for (const request of active) {
            const currentShift = await this.findSameScheduledShift(request);
            if (!currentShift) {
                await this.closeByScheduleSync(api, request.id);
            } else if (request.workShiftId !== currentShift.id) {
                await prisma.replacementRequest.update({
                    where: { id: request.id },
                    data: { workShiftId: currentShift.id }
                });
            }
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
        const availability = await scheduleAvailabilityService.getAvailabilityForDate(
            request.shiftDate,
            scheduleAvailabilityService.getMonthlyScheduleSheetName(request.shiftDate)
        );
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
                id: { in: staffIdsWithDesiredAvailability, not: request.requesterStaffId },
                isActive: true,
                user: { botBlockedAt: null },
                ...this.getLocationFilter(request, wave)
            },
            include: { user: true, location: true },
            orderBy: { fullName: "asc" }
        }) as StaffWithUserLocation[];

        const candidateIds = candidates.map(c => c.id);
        const [busyShifts, existingResponses] = await Promise.all([
            prisma.workShift.findMany({
                where: {
                    staffId: { in: candidateIds },
                    date: { gte: this.kyivStartOfDay(request.shiftDate), lt: this.nextKyivDay(request.shiftDate) }
                },
                select: { staffId: true }
            }),
            prisma.replacementResponse.findMany({
                where: { requestId: request.id, staffId: { in: candidateIds } },
                select: { staffId: true }
            })
        ]);

        const busy = new Set(busyShifts.map(s => s.staffId));
        const alreadyAsked = new Set(existingResponses.map(r => r.staffId));

        return candidates
            .filter(candidate => !busy.has(candidate.id) && !alreadyAsked.has(candidate.id))
            .map(candidate => ({ staff: candidate, availabilityKind: kindByStaff.get(candidate.id)! }));
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
                .text("Не можу", `staff_repl_decline_${request.id}`);

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

    private async notifyRequesterFound(api: Api, request: RequestWithRelations) {
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

        await api.sendMessage(Number(request.requester.user.telegramId), this.formatRequesterFailureText(request), {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🤍 Написати в сапорт", "open_support_dialog")
        }).catch(() => { });
        await this.notifyAdminFailed(api, requestId);
        await this.inactivateOpenResponses(api, requestId, "Запит вже закрито.");
    }

    private async closeByScheduleSync(api: Api, requestId: string) {
        await prisma.replacementRequest.updateMany({
            where: { id: requestId, status: ReplacementRequestStatus.ACTIVE },
            data: {
                status: ReplacementRequestStatus.CLOSED_BY_SCHEDULE_SYNC,
                completedAt: new Date(),
                closedReason: "schedule_changed",
                nextWaveAt: null
            }
        });

        const request = await this.getRequest(requestId);
        if (!request) return;

        await api.sendMessage(Number(request.requester.user.telegramId), "Пошук закрито.\nГрафік уже оновлено.", {
            parse_mode: "HTML"
        }).catch(() => { });
        await this.inactivateOpenResponses(api, requestId, "Запит вже закрито.\nГрафік оновлено.");
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

        await Promise.all(responses.map(response => this.editCandidateMessage(api, response.chatId, response.messageId, text)));
    }

    private async editCandidateMessage(api: Api, chatId?: bigint | null, messageId?: number | null, text?: string) {
        if (!chatId || !messageId || !text) return;
        await api.editMessageText(Number(chatId), messageId, text, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] }
        }).catch((err) => logger.debug({ err, chatId: chatId.toString(), messageId }, "Replacement message edit skipped"));
    }

    private async isRequestObsoleteAfterScheduleChange(request: RequestWithRelations) {
        return !(await this.findSameScheduledShift(request));
    }

    private async findSameScheduledShift(request: RequestWithRelations) {
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

    private async hasShiftOnDate(staffId: string, date: Date) {
        const count = await prisma.workShift.count({
            where: {
                staffId,
                date: { gte: this.kyivStartOfDay(date), lt: this.nextKyivDay(date) }
            }
        });
        return count > 0;
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

        const finalCloseAt = new Date(this.getShiftStartAt(request).getTime() - FINAL_WAVE_CLOSE_LEAD_MS);
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

    private formatShiftDetails(request: RequestWithRelations) {
        return `${this.formatDate(request.shiftDate)}\n${escapeHtml(request.location.name)}\n${escapeHtml(this.formatShiftTime(request))}`;
    }

    private formatShiftTime(request: { shiftStartTime?: Date | null | undefined; shiftEndTime?: Date | null | undefined; shiftDate: Date; location?: Location }) {
        if (request.shiftStartTime && request.shiftEndTime) {
            return `${this.formatTime(request.shiftStartTime)}-${this.formatTime(request.shiftEndTime)}`;
        }
        return getShiftTimeFromLocationSchedule(request.location?.schedule, request.shiftDate) || "час не вказано";
    }

    formatShiftButtonLabel(shift: { date: Date; location: Location }) {
        return `${this.formatDate(shift.date)}, ${shift.location.name}`;
    }

    formatConfirmationText(shift: { date: Date; startTime?: Date | null; endTime?: Date | null; location: Location }) {
        const time = this.formatShiftTime({
            shiftDate: shift.date,
            shiftStartTime: shift.startTime,
            shiftEndTime: shift.endTime,
            location: shift.location
        });

        return `Потрібна підміна на цю зміну:\n${this.formatDate(shift.date)}\n${escapeHtml(shift.location.name)}\n${escapeHtml(time)}\n\nПочати пошук?`;
    }

    formatAdminBoardText(requests: Awaited<ReturnType<ReplacementService["listActiveRequestsForAdmin"]>>) {
        if (requests.length === 0) {
            return "🔎 <b>Replacement searches</b>\n\nNo active replacement searches.";
        }

        let text = `🔎 <b>Replacement searches</b>\n\nOpen requests: <b>${requests.length}</b>\n`;

        requests.forEach((request, index) => {
            const sent = request.responses.filter((response) => response.status === ReplacementResponseStatus.SENT).length;
            const accepted = request.responses.filter((response) => response.status === ReplacementResponseStatus.ACCEPTED).length;
            const declined = request.responses.filter((response) => response.status === ReplacementResponseStatus.DECLINED).length;
            const failed = request.responses.filter((response) => response.status === ReplacementResponseStatus.DELIVERY_FAILED).length;
            const nextWave = request.nextWaveAt
                ? this.formatDateTime(request.nextWaveAt)
                : "not scheduled";

            text +=
                `\n<b>${index + 1}. ${escapeHtml(request.location.name)}</b>\n` +
                `📅 ${this.formatDate(request.shiftDate)} · ${escapeHtml(this.formatShiftTime(request))}\n` +
                `🏙 ${escapeHtml(request.city)}\n` +
                `👤 Photographer: ${escapeHtml(this.formatShortName(request.requester.fullName))}\n` +
                `🌊 Wave: <code>${escapeHtml(request.currentWave || "not started")}</code>\n` +
                `⏭ Next check: ${escapeHtml(nextWave)}\n` +
                `📨 Responses: ${sent} pending / ${declined} declined / ${failed} failed / ${accepted} accepted\n`;
        });

        return text;
    }

    private formatAdminNotification(kind: "started" | "found" | "failed", request: RequestWithRelations) {
        const titleByKind = {
            started: "🔁 <b>Replacement search started.</b>",
            found: "✅ <b>Replacement found.</b>",
            failed: "⚠️ <b>Replacement not found.</b>"
        };
        const actionByKind = {
            started: "The request is open. Search waves will run automatically; monitor it and help manually if needed.",
            found: "Please update the schedule manually and sync the changes.",
            failed: "All available search waves finished without a result. Please contact the photographer and resolve manually."
        };

        const replacementLine = request.replacement
            ? `\n✅ Replacement photographer: ${escapeHtml(this.formatShortName(request.replacement.fullName))}`
            : "";

        return (
            `${titleByKind[kind]}\n\n` +
            `<b>Shift</b>\n` +
            `📅 Date: <b>${this.formatDate(request.shiftDate)}</b>\n` +
            `🕒 Time: <b>${escapeHtml(this.formatShiftTime(request))}</b>\n` +
            `📍 Location: <b>${escapeHtml(request.location.name)}</b>\n` +
            `🏙 City: ${escapeHtml(request.city)}\n\n` +
            `<b>People</b>\n` +
            `👤 Photographer: ${escapeHtml(this.formatShortName(request.requester.fullName))}${replacementLine}\n\n` +
            `<b>Next step</b>\n` +
            `${actionByKind[kind]}`
        );
    }

    private formatRequesterFailureText(request: RequestWithRelations) {
        return (
            `Поки що підміну не знайдено.\n\n` +
            `📅 <b>${this.formatDate(request.shiftDate)}</b>\n` +
            `🕒 <b>${escapeHtml(this.formatShiftTime(request))}</b>\n` +
            `📍 <b>${escapeHtml(request.location.name)}</b>\n\n` +
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

    private formatShortName(fullName: string) {
        return fullName.trim().split(/\s+/).slice(0, 2).join(" ");
    }

    private kyivStartOfDay(date: Date) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: KYIV_TIMEZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(date);
        const year = Number(parts.find(p => p.type === "year")?.value);
        const month = Number(parts.find(p => p.type === "month")?.value);
        const day = Number(parts.find(p => p.type === "day")?.value);
        return new Date(Date.UTC(year, month - 1, day));
    }

    private nextKyivDay(date: Date) {
        const start = this.kyivStartOfDay(date);
        return new Date(start.getTime() + 24 * 60 * 60 * 1000);
    }

    private kyivDateWithTime(date: Date, hour: number, minute: number) {
        const start = this.kyivStartOfDay(date);
        return new Date(start.getTime() + (hour - 2) * 60 * 60 * 1000 + minute * 60 * 1000);
    }
}

export const replacementService = new ReplacementService();
