import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReplacementAvailabilityKind, ReplacementSearchWave } from "@prisma/client";

const prismaMock = {
    replacementRequest: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    replacementResponse: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
    },
    location: {
        count: vi.fn(),
    },
    staffProfile: {
        findMany: vi.fn(),
    },
    workShift: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
    },
};

const scheduleAvailabilityService = {
    getAvailabilityForDate: vi.fn(),
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
    });

    it("advances past an empty wave and sends the next available wave", async () => {
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
        scheduleAvailabilityService.getAvailabilityForDate.mockResolvedValue(new Map([
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
        expect(prismaMock.replacementRequest.update).toHaveBeenCalledWith({
            where: { id: request.id },
            data: { currentWave: ReplacementSearchWave.SAME_LOCATION_LIMITED, nextWaveAt: expect.any(Date) },
        });
        expect(prismaMock.replacementResponse.create).toHaveBeenCalledWith({
            data: {
                requestId: request.id,
                staffId: "limited-1",
                wave: ReplacementSearchWave.SAME_LOCATION_LIMITED,
                availabilityKind: ReplacementAvailabilityKind.LIMITED,
            },
        });
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
});
