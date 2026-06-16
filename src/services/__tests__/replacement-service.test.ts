import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplacementAvailabilityKind, ReplacementSearchWave } from "@prisma/client";

const prismaMock = {
    $transaction: vi.fn(async (callback: any) => callback(prismaMock)),
    replacementRequest: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    replacementResponse: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        count: vi.fn(),
    },
    location: {
        count: vi.fn(),
        findUnique: vi.fn(),
    },
    staffProfile: {
        findMany: vi.fn(),
    },
    workShift: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
    },
};

const scheduleAvailabilityService = {
    getAvailabilityForDate: vi.fn(),
    getAvailabilityForDateFromSchedule: vi.fn(),
    getMonthlyScheduleSheetName: vi.fn(),
};

const defaultQueue = {
    add: vi.fn(),
};

vi.mock("../../db/core.js", () => ({
    default: prismaMock,
}));

vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService,
}));

vi.mock("../../core/queue.js", () => ({
    defaultQueue,
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("ReplacementService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        scheduleAvailabilityService.getMonthlyScheduleSheetName.mockReturnValue("Травень 2030");
    });

    it("schedules a follow-up job when the current wave has no candidates", async () => {
        const request: any = {
            id: "request-1",
            requesterStaffId: "requester-1",
            locationId: "location-1",
            city: "Київ",
            shiftDate: new Date("2030-05-10T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-10T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-10T20:00:00.000Z"),
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            location: { id: "location-1", name: "Smile Park (Darynok)", city: "Київ", schedule: null },
            requester: { id: "requester-1", fullName: "Кравченко Катерина", user: { telegramId: 772086875n } },
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        prismaMock.workShift.findFirst.mockResolvedValue({ id: "shift-1" });
        prismaMock.location.count.mockResolvedValue(2);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.update.mockImplementation(async ({ data }: any) => {
            Object.assign(request, data);
            return { ...request };
        });
        scheduleAvailabilityService.getAvailabilityForDateFromSchedule.mockResolvedValue(new Map([
            ["limited-1", "limited"],
        ]));
        prismaMock.staffProfile.findMany.mockResolvedValue([
            {
                id: "limited-1",
                fullName: "Прокопʼєва Маріанна",
                user: { telegramId: 123456789n },
                location: request.location,
            },
        ]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.create.mockResolvedValue({ id: "response-1" });
        prismaMock.replacementResponse.update.mockResolvedValue({});
        prismaMock.replacementResponse.count.mockResolvedValue(1);
        defaultQueue.add.mockResolvedValue({ id: "job-1" });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 123456789 }, message_id: 42 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api as any, request.id);

        expect(prismaMock.replacementRequest.update).toHaveBeenCalledWith({
            where: { id: request.id },
            data: { currentWave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE, nextWaveAt: expect.any(Date) },
        });
        expect(defaultQueue.add).toHaveBeenCalledWith(
            "replacement-dispatch-wave",
            { requestId: request.id },
            {
                delay: 60_000,
                attempts: 3,
                backoff: { type: "fixed", delay: 60_000 },
                removeOnComplete: true,
            }
        );
        expect(prismaMock.replacementResponse.create).not.toHaveBeenCalled();
        expect(scheduleAvailabilityService.getAvailabilityForDateFromSchedule).toHaveBeenCalledWith(request.shiftDate);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("notifies the main admin in English with shortened photographer name when replacement is not found", async () => {
        const request: any = {
            id: "request-2",
            requesterStaffId: "requester-2",
            locationId: "location-2",
            city: "Львів",
            shiftDate: new Date("2030-05-11T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-11T11:00:00.000Z"),
            shiftEndTime: new Date("2030-05-11T18:00:00.000Z"),
            status: "ACTIVE",
            currentWave: ReplacementSearchWave.SAME_LOCATION_LIMITED,
            nextWaveAt: null,
            location: { id: "location-2", name: "Dragon Park", city: "Львів", schedule: null },
            requester: { id: "requester-2", fullName: "Бланк Анастасія Тарасівна", user: { telegramId: 1164289764n } },
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockResolvedValue(request);
        prismaMock.workShift.findFirst.mockResolvedValue({ id: "shift-2" });
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.replacementResponse.findMany.mockImplementation(async ({ where }: any) => {
            if (where?.status === "SENT") return [];
            return [
                { wave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE },
                { wave: ReplacementSearchWave.SAME_LOCATION_LIMITED },
            ];
        });
        prismaMock.replacementRequest.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.replacementResponse.updateMany.mockResolvedValue({ count: 0 });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 107794048 }, message_id: 10 }),
            editMessageText: vi.fn(),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api as any, request.id);

        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Replacement not found."),
            { parse_mode: "HTML" }
        );
        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Photographer: Бланк Анастасія\n\n"),
            { parse_mode: "HTML" }
        );
        expect(api.sendMessage).not.toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Тарасівна"),
            expect.anything()
        );
    });

    it("keeps the final wave open until the shift starts when that is later than the normal interval", async () => {
        const request: any = {
            id: "request-3",
            requesterStaffId: "requester-3",
            locationId: "location-3",
            city: "Львів",
            shiftDate: new Date("2030-05-11T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-11T11:00:00.000Z"),
            shiftEndTime: new Date("2030-05-11T18:00:00.000Z"),
            status: "ACTIVE",
            currentWave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE,
            nextWaveAt: null,
            location: { id: "location-3", name: "Dragon Park", city: "Львів", schedule: null },
            requester: { id: "requester-3", fullName: "Бланк Анастасія Тарасівна", user: { telegramId: 1164289764n } },
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        prismaMock.workShift.findFirst.mockResolvedValue({ id: "shift-3" });
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.replacementResponse.findMany.mockResolvedValue([
            { wave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE },
        ]);
        prismaMock.replacementRequest.update.mockImplementation(async ({ data }: any) => {
            Object.assign(request, data);
            return { ...request };
        });
        scheduleAvailabilityService.getAvailabilityForDateFromSchedule.mockResolvedValue(new Map([
            ["limited-3", "limited"],
        ]));
        prismaMock.staffProfile.findMany.mockResolvedValue([
            {
                id: "limited-3",
                fullName: "Ольхович Леся Ігорівна",
                user: { telegramId: 5725322763n },
                location: request.location,
            },
        ]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.create.mockResolvedValue({ id: "response-3" });
        prismaMock.replacementResponse.update.mockResolvedValue({});
        prismaMock.replacementResponse.count.mockResolvedValue(1);
        defaultQueue.add.mockResolvedValue({ id: "job-3" });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 5725322763 }, message_id: 43 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api as any, request.id);

        const expectedFinalCloseAt = new Date("2030-05-11T11:00:00.000Z");
        expect(prismaMock.replacementRequest.update).toHaveBeenCalledWith({
            where: { id: request.id },
            data: {
                currentWave: ReplacementSearchWave.SAME_LOCATION_LIMITED,
                nextWaveAt: expectedFinalCloseAt,
            },
        });
        const queueCall = defaultQueue.add.mock.calls.at(-1);
        expect(queueCall?.[0]).toBe("replacement-dispatch-wave");
        expect(queueCall?.[1]).toEqual({ requestId: request.id });
        expect(queueCall?.[2]).toMatchObject({ attempts: 3, removeOnComplete: true });
        expect(queueCall?.[2].delay).toBeGreaterThan(8 * 60 * 60 * 1000);
    });

    it("notifies the main admin in English when replacement search starts", async () => {
        const shift: any = {
            id: "shift-4",
            staffId: "requester-4",
            locationId: "location-4",
            date: new Date("2030-05-11T00:00:00.000Z"),
            startTime: new Date("2030-05-11T11:00:00.000Z"),
            endTime: new Date("2030-05-11T18:00:00.000Z"),
            location: { id: "location-4", name: "Dragon Park", city: "Львів", schedule: null },
            staff: { id: "requester-4", fullName: "Бланк Анастасія Тарасівна", user: { telegramId: 1164289764n } },
        };
        const createdRequest: any = {
            id: "request-4",
            requesterStaffId: "requester-4",
            locationId: "location-4",
            city: "Львів",
            shiftDate: shift.date,
            shiftStartTime: shift.startTime,
            shiftEndTime: shift.endTime,
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            location: shift.location,
            requester: shift.staff,
            replacement: null,
        };

        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.create.mockResolvedValue(createdRequest);
        prismaMock.replacementRequest.findUnique
            .mockResolvedValueOnce(createdRequest)
            .mockResolvedValueOnce({ ...createdRequest, status: "CANCELLED" });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 107794048 }, message_id: 11 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().startRequest(api as any, "requester-4", "shift-4");

        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Replacement search started."),
            { parse_mode: "HTML" }
        );
        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Photographer: Бланк Анастасія\n\n"),
            { parse_mode: "HTML" }
        );
    });

    it("notifies the main admin in English when the requester cancels a replacement search", async () => {
        const request: any = {
            id: "request-cancelled",
            requesterStaffId: "requester-cancel",
            locationId: "location-cancel",
            city: "Черкаси",
            shiftDate: new Date("2030-05-12T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-12T11:00:00.000Z"),
            shiftEndTime: new Date("2030-05-12T18:00:00.000Z"),
            status: "CANCELLED",
            currentWave: null,
            nextWaveAt: null,
            location: { id: "location-cancel", name: "Fantasy Town", city: "Черкаси", schedule: null },
            requester: { id: "requester-cancel", fullName: "Смірнова Дарина", user: { telegramId: 7927905186n } },
            replacement: null,
        };

        prismaMock.replacementRequest.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.replacementRequest.findUnique.mockResolvedValue(request);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.updateMany.mockResolvedValue({ count: 0 });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 107794048 }, message_id: 12 }),
            editMessageText: vi.fn(),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        const result = await new ReplacementService().cancelRequest(api as any, "requester-cancel", "request-cancelled");

        expect(result).toBe(true);
        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Replacement search cancelled."),
            { parse_mode: "HTML" }
        );
        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("Photographer: Смірнова Дарина\n\n"),
            { parse_mode: "HTML" }
        );
    });

    it("starts a manual admin replacement search without a requester photographer", async () => {
        const location: any = {
            id: "location-admin",
            name: "Smile Park (Darynok)",
            city: "Київ",
            schedule: null,
        };
        const createdRequest: any = {
            id: "request-admin",
            requesterStaffId: null,
            locationId: location.id,
            city: location.city,
            shiftDate: new Date("2030-05-16T00:00:00.000Z"),
            shiftStartTime: null,
            shiftEndTime: null,
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            location,
            requester: null,
            replacement: null,
        };

        prismaMock.location.findUnique.mockResolvedValue(location);
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.create.mockResolvedValue(createdRequest);
        prismaMock.replacementRequest.findUnique
            .mockResolvedValueOnce(createdRequest)
            .mockResolvedValueOnce({ ...createdRequest, status: "CANCELLED" });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 107794048 }, message_id: 13 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().startAdminRequest(api as any, location.id, createdRequest.shiftDate);

        expect(prismaMock.replacementRequest.create).toHaveBeenCalledWith({
            data: {
                locationId: location.id,
                city: location.city,
                shiftDate: createdRequest.shiftDate,
                shiftStartTime: createdRequest.shiftStartTime,
                shiftEndTime: createdRequest.shiftEndTime,
            },
        });
        expect(api.sendMessage).toHaveBeenCalledWith(
            107794048,
            expect.stringContaining("empty shift, started by main admin"),
            { parse_mode: "HTML" }
        );
    });

    it("dispatches a manual admin replacement search instead of closing it as obsolete", async () => {
        const request: any = {
            id: "request-admin-dispatch",
            requesterStaffId: null,
            locationId: "location-admin",
            city: "Київ",
            shiftDate: new Date("2030-05-16T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-16T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-16T20:00:00.000Z"),
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            location: { id: "location-admin", name: "Smile Park (Darynok)", city: "Київ", schedule: null },
            requester: null,
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.update.mockImplementation(async ({ data }: any) => {
            Object.assign(request, data);
            return { ...request };
        });
        scheduleAvailabilityService.getAvailabilityForDateFromSchedule.mockResolvedValue(new Map([
            ["candidate-1", "available"],
        ]));
        prismaMock.staffProfile.findMany.mockResolvedValue([
            {
                id: "candidate-1",
                fullName: "Прокопʼєва Маріанна",
                user: { telegramId: 123456789n },
                location: request.location,
            },
        ]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.create.mockResolvedValue({ id: "response-admin" });
        prismaMock.replacementResponse.update.mockResolvedValue({});
        prismaMock.replacementResponse.count.mockResolvedValue(1);
        defaultQueue.add.mockResolvedValue({ id: "job-admin" });

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 123456789 }, message_id: 42 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api as any, request.id);

        expect(prismaMock.replacementRequest.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: request.id, status: "ACTIVE" },
                data: expect.objectContaining({ closedReason: "schedule_changed" }),
            })
        );
        expect(prismaMock.replacementResponse.create).toHaveBeenCalledWith({
            data: {
                requestId: request.id,
                staffId: "candidate-1",
                wave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE,
                availabilityKind: ReplacementAvailabilityKind.AVAILABLE,
            },
        });
    });

    it("does not message the same photographer again when a cancelled search is restarted for the same shift", async () => {
        const request: any = {
            id: "request-restarted",
            workShiftId: "shift-restarted",
            requesterStaffId: "requester-restarted",
            locationId: "location-restarted",
            city: "Черкаси",
            shiftDate: new Date("2030-05-16T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-16T11:00:00.000Z"),
            shiftEndTime: new Date("2030-05-16T18:00:00.000Z"),
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            location: { id: "location-restarted", name: "Fantasy Town", city: "Черкаси", schedule: null },
            requester: { id: "requester-restarted", fullName: "Смірнова Дарина", user: { telegramId: 7927905186n } },
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        prismaMock.workShift.findFirst.mockResolvedValue({ id: "shift-restarted" });
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.replacementResponse.findMany.mockImplementation(async ({ where, distinct }: any) => {
            if (distinct?.includes("wave")) return [];
            if (where?.staffId?.in?.includes("candidate-restarted")) {
                return [{ staffId: "candidate-restarted" }];
            }
            return [];
        });
        prismaMock.replacementRequest.update.mockImplementation(async ({ data }: any) => {
            Object.assign(request, data);
            return { ...request };
        });
        scheduleAvailabilityService.getAvailabilityForDateFromSchedule.mockResolvedValue(new Map([
            ["candidate-restarted", "available"],
        ]));
        prismaMock.staffProfile.findMany.mockResolvedValue([
            {
                id: "candidate-restarted",
                fullName: "Прокопʼєва Маріанна",
                user: { telegramId: 123456789n },
                location: request.location,
            },
        ]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        defaultQueue.add.mockResolvedValue({ id: "job-restarted" });

        const api = {
            sendMessage: vi.fn(),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api as any, request.id);

        expect(prismaMock.replacementResponse.create).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(defaultQueue.add).toHaveBeenCalledWith(
            "replacement-dispatch-wave",
            { requestId: request.id },
            expect.objectContaining({ attempts: 3, removeOnComplete: true })
        );
    });

    it("shows shift details to the replacement photographer after accepting", async () => {
        const request: any = {
            id: "request-accept",
            requesterStaffId: "requester-accept",
            locationId: "location-accept",
            city: "Київ",
            shiftDate: new Date("2030-05-15T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-15T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-15T20:00:00.000Z"),
            status: "ACTIVE",
            currentWave: ReplacementSearchWave.SAME_LOCATION_AVAILABLE,
            nextWaveAt: null,
            location: { id: "location-accept", name: "Smile Park (Darynok)", city: "Київ", schedule: null },
            requester: { id: "requester-accept", fullName: "Кравченко Катерина", user: { telegramId: 772086875n } },
            replacement: null,
        };
        const replacementStaff: any = {
            id: "replacement-accept",
            fullName: "Попик Вікторія Русланівна",
            user: { telegramId: 1132074881n },
        };

        prismaMock.replacementResponse.findUnique.mockResolvedValue({
            id: "response-accept",
            requestId: request.id,
            staffId: replacementStaff.id,
            status: "SENT",
            chatId: 1132074881n,
            messageId: 321,
            request,
            staff: replacementStaff,
        });
        prismaMock.workShift.count.mockResolvedValue(0);
        prismaMock.replacementRequest.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.replacementResponse.update.mockResolvedValue({});
        prismaMock.replacementResponse.updateMany.mockResolvedValue({});
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.findUnique.mockResolvedValue({
            ...request,
            replacement: replacementStaff,
        });
        prismaMock.replacementRequest.update.mockResolvedValue({});

        const api = {
            editMessageText: vi.fn().mockResolvedValue({}),
            sendMessage: vi.fn().mockResolvedValue({ chat: { id: 107794048 }, message_id: 12 }),
        };

        const { ReplacementService } = await import("../replacement-service.js");
        const result = await new ReplacementService().accept(api as any, replacementStaff.id, request.id);

        expect(result).toBe("accepted");
        expect(api.editMessageText).toHaveBeenCalledWith(
            1132074881,
            321,
            expect.stringContaining("Ваша зміна:\n15 травня\nSmile Park (Darynok)\n15:00-23:00"),
            {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] },
            }
        );
    });

    it("reports a closed request when a photographer accepts after another replacement was found", async () => {
        const request: any = {
            id: "request-found",
            locationId: "location-found",
            city: "Запоріжжя",
            shiftDate: new Date("2030-05-15T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-15T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-15T20:00:00.000Z"),
            status: "FOUND",
            location: { id: "location-found", name: "Volkland 3", city: "Запоріжжя", schedule: null },
            requester: { id: "requester-found", fullName: "Іщенко Вікторія", user: { telegramId: 772086875n } },
            replacementStaffId: "replacement-other",
        };

        prismaMock.replacementResponse.findUnique.mockResolvedValue({
            id: "response-late",
            requestId: request.id,
            staffId: "replacement-late",
            status: "INACTIVE",
            chatId: 1132074881n,
            messageId: 321,
            request,
            staff: { id: "replacement-late", fullName: "Пізній Фотограф", user: { telegramId: 1132074881n } },
        });

        const { ReplacementService } = await import("../replacement-service.js");
        const result = await new ReplacementService().accept({} as any, "replacement-late", request.id);

        expect(result).toBe("closed");
        expect(prismaMock.workShift.count).not.toHaveBeenCalled();
        expect(prismaMock.replacementRequest.updateMany).not.toHaveBeenCalled();
    });

    it("reports a closed request when a photographer declines after another replacement was found", async () => {
        const request: any = {
            id: "request-found-decline",
            locationId: "location-found",
            city: "Запоріжжя",
            shiftDate: new Date("2030-05-15T00:00:00.000Z"),
            status: "FOUND",
            replacementStaffId: "replacement-other",
        };

        prismaMock.replacementResponse.findUnique.mockResolvedValue({
            id: "response-late-decline",
            requestId: request.id,
            staffId: "replacement-late",
            status: "INACTIVE",
            chatId: 1132074881n,
            messageId: 321,
            request,
        });

        const { ReplacementService } = await import("../replacement-service.js");
        const result = await new ReplacementService().decline({} as any, "replacement-late", request.id);

        expect(result).toBe("closed");
        expect(prismaMock.replacementResponse.update).not.toHaveBeenCalled();
        expect(prismaMock.replacementResponse.count).not.toHaveBeenCalled();
    });

    it("blocks a duplicate active search for the same requester, date, and location after a shift resync", async () => {
        const shift: any = {
            id: "shift-new",
            staffId: "requester-5",
            locationId: "location-5",
            date: new Date("2030-05-12T00:00:00.000Z"),
            startTime: new Date("2030-05-12T11:00:00.000Z"),
            endTime: new Date("2030-05-12T18:00:00.000Z"),
            location: { id: "location-5", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "requester-5", fullName: "Прокопʼєва Маріанна", user: { telegramId: 769506907n } },
        };

        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.replacementRequest.findFirst.mockResolvedValue({
            id: "orphan-request",
            workShiftId: null,
            requesterStaffId: "requester-5",
            locationId: "location-5",
            shiftDate: shift.date,
            status: "ACTIVE",
        });

        const api = { sendMessage: vi.fn() };

        const { ReplacementService } = await import("../replacement-service.js");
        await expect(new ReplacementService().startRequest(api as any, "requester-5", "shift-new"))
            .rejects.toThrow("REQUEST_ALREADY_ACTIVE");

        expect(prismaMock.replacementRequest.findFirst).toHaveBeenCalledWith({
            where: {
                status: "ACTIVE",
                OR: [
                    { workShiftId: "shift-new" },
                    {
                        requesterStaffId: "requester-5",
                        locationId: "location-5",
                        shiftDate: { gte: expect.any(Date), lt: expect.any(Date) },
                    },
                ],
            },
        });
        expect(prismaMock.replacementRequest.create).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("blocks restarting a search when the same shift already failed to find a replacement", async () => {
        const shift: any = {
            id: "shift-failed",
            staffId: "requester-7",
            locationId: "location-7",
            date: new Date("2030-05-14T00:00:00.000Z"),
            startTime: new Date("2030-05-14T11:00:00.000Z"),
            endTime: new Date("2030-05-14T18:00:00.000Z"),
            location: { id: "location-7", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "requester-7", fullName: "Прокопʼєва Маріанна", user: { telegramId: 769506907n } },
        };

        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.replacementRequest.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "failed-request",
                workShiftId: null,
                requesterStaffId: "requester-7",
                locationId: "location-7",
                shiftDate: shift.date,
                status: "FAILED",
            });

        const api = { sendMessage: vi.fn() };

        const { ReplacementService } = await import("../replacement-service.js");
        await expect(new ReplacementService().startRequest(api as any, "requester-7", "shift-failed"))
            .rejects.toThrow("REQUEST_PREVIOUSLY_FAILED");

        expect(prismaMock.replacementRequest.create).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("reattaches an active orphaned replacement request to the resynced work shift", async () => {
        const request: any = {
            id: "request-orphan",
            workShiftId: null,
            requesterStaffId: "requester-6",
            locationId: "location-6",
            shiftDate: new Date("2030-05-13T00:00:00.000Z"),
            status: "ACTIVE",
            location: { id: "location-6", name: "Smile Park", city: "Київ", schedule: null },
            requester: { id: "requester-6", fullName: "Прокопʼєва Маріанна", user: { telegramId: 769506907n } },
        };

        prismaMock.replacementRequest.findMany.mockResolvedValue([request]);
        prismaMock.workShift.findFirst.mockResolvedValue({ id: "shift-resynced" });
        prismaMock.replacementRequest.update.mockResolvedValue({ ...request, workShiftId: "shift-resynced" });

        const api = { sendMessage: vi.fn(), editMessageText: vi.fn() };

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().closeActiveRequestsChangedBySchedule(api as any);

        expect(prismaMock.replacementRequest.update).toHaveBeenCalledWith({
            where: { id: "request-orphan" },
            data: { workShiftId: "shift-resynced" },
        });
        expect(prismaMock.replacementRequest.updateMany).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    describe("kyivDateWithTime DST handling", () => {
        it("encodes 12:00 Kyiv as 09:00 UTC during EEST (summer)", async () => {
            const { ReplacementService } = await import("../replacement-service.js");
            const svc: any = new ReplacementService();
            const summerDate = new Date(Date.UTC(2026, 4, 30));
            const result: Date = svc.kyivDateWithTime(summerDate, 12, 0);
            expect(result.toISOString()).toBe("2026-05-30T09:00:00.000Z");
        });

        it("encodes 21:00 Kyiv as 18:00 UTC during EEST (summer)", async () => {
            const { ReplacementService } = await import("../replacement-service.js");
            const svc: any = new ReplacementService();
            const summerDate = new Date(Date.UTC(2026, 4, 30));
            const result: Date = svc.kyivDateWithTime(summerDate, 21, 0);
            expect(result.toISOString()).toBe("2026-05-30T18:00:00.000Z");
        });

        it("encodes 14:00 Kyiv as 12:00 UTC during EET (winter)", async () => {
            const { ReplacementService } = await import("../replacement-service.js");
            const svc: any = new ReplacementService();
            const winterDate = new Date(Date.UTC(2026, 0, 15));
            const result: Date = svc.kyivDateWithTime(winterDate, 14, 0);
            expect(result.toISOString()).toBe("2026-01-15T12:00:00.000Z");
        });
    });
});
