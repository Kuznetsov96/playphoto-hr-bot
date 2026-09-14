import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    replacementRequest: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
    },
    location: { findUnique: vi.fn(), count: vi.fn() },
    staffProfile: { findMany: vi.fn() },
    replacementResponse: {
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
    },
    $transaction: vi.fn(async (callback: any) => callback(prismaMock)),
};

const defaultQueueMock = { add: vi.fn() };

const scheduleAvailabilityServiceMock = {
    getAvailabilityForDate: vi.fn(),
    getAvailabilityForDateFromSchedule: vi.fn().mockResolvedValue(new Map()),
    getMonthlyScheduleSheetName: vi.fn().mockReturnValue("Вересень 2026"),
};

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: scheduleAvailabilityServiceMock,
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: defaultQueueMock }));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const api: any = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
};

describe("isManual — розрізнення ручної заявки адміна і звичайної", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.create.mockImplementation(async ({ data }: any) => ({
            id: "request-1",
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            ...data,
        }));
        // notifyAdminStarted тягне заявку через findUnique — повертаємо те саме,
        // що щойно "створили", з relations, потрібними formatAdminNotification.
        prismaMock.replacementRequest.findUnique.mockImplementation(async () => {
            const created = await prismaMock.replacementRequest.create.mock.results[0]?.value;
            return {
                ...created,
                location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
                requester: null,
                replacement: null,
            };
        });
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("startAdminRequest проставляє isManual: true — ручний пошук без зміни в графіку", async () => {
        prismaMock.location.findUnique.mockResolvedValue({
            id: "loc-1",
            name: "Smile Park",
            city: "Київ",
            schedule: null,
        });
        // findFirst викликається двічі: перевірка наявної зміни на день (null —
        // зміни нема) і перевірка наявної заявки (null — не блокує).
        prismaMock.workShift.findFirst.mockResolvedValue(null);

        const { replacementService } = await import("../replacement-service.js");
        const futureDate = new Date("2030-05-10T00:00:00.000Z");
        await replacementService.startAdminRequest(api, "loc-1", futureDate);

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.isManual).toBe(true);
    });

    it("startRequest не проставляє isManual явно — працює дефолт схеми false", async () => {
        const shift = {
            id: "shift-1",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-10T00:00:00.000Z"),
            startTime: new Date("2030-05-10T08:00:00.000Z"),
            endTime: new Date("2030-05-10T17:00:00.000Z"),
            awsScheduledShiftPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        };
        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.workShift.findFirst.mockResolvedValue(shift);

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.isManual).toBeUndefined();
    });
});

describe("getSameReplacementSearchFilter — гілка «та сама заявка» за isManual", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.location.count.mockResolvedValue(1);
        // Один кандидат з доступністю AVAILABLE — доводить пошук кандидатів
        // до replacementResponse.findMany з where.request, де живе фільтр.
        scheduleAvailabilityServiceMock.getAvailabilityForDateFromSchedule.mockResolvedValue(
            new Map([["staff-candidate-1", "available"]])
        );
        prismaMock.staffProfile.findMany.mockResolvedValue([
            {
                id: "staff-candidate-1",
                fullName: "Кандидат Тест",
                user: { telegramId: 999n, botBlockedAt: null },
                location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            },
        ]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        // findNextWave запитує { requestId } (без .request) — і саме тому
        // findMany мокається реалізацією, що розрізняє виклики за where.
        prismaMock.replacementResponse.findMany.mockImplementation(async ({ where }: any) => {
            if (where?.request) return [];
            return [];
        });
        prismaMock.replacementResponse.create.mockResolvedValue({ id: "response-1" });
        prismaMock.replacementResponse.update.mockResolvedValue({});
        prismaMock.replacementResponse.count.mockResolvedValue(1);
        defaultQueueMock.add.mockResolvedValue({ id: "job-1" });
    });

    // Перевіряємо саме аргументи findMany, бо мок Prisma ігнорує where —
    // без цього тест зеленіє й на зламаній реалізації (workShiftId: null).
    it("ручна заявка (isManual: true, workShiftId: null) шукається гілкою за isManual", async () => {
        const request: any = {
            id: "request-manual-1",
            requesterStaffId: null,
            workShiftId: null,
            scheduledShiftPublicId: null,
            isManual: true,
            locationId: "loc-1",
            city: "Київ",
            shiftDate: new Date("2030-05-10T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-10T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-10T20:00:00.000Z"),
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            awsReplacementPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            requester: null,
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        // Заявка без requesterStaffId: isRequestObsoleteAfterScheduleChange
        // перевіряє, чи зʼявилась зміна на локацію/дату — тут її нема.
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.update.mockResolvedValue({});

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api, request.id);

        expect(prismaMock.replacementResponse.findMany).toHaveBeenCalled();
        const call = prismaMock.replacementResponse.findMany.mock.calls.find(
            ([args]: any) => args?.where?.request
        );
        expect(call).toBeDefined();
        const requestFilter = call![0].where.request;
        expect(requestFilter.OR).toContainEqual(
            expect.objectContaining({ isManual: true })
        );
        expect(requestFilter.OR).not.toContainEqual(
            expect.objectContaining({ workShiftId: null })
        );
    });

    // Ключовий тест цієї роботи: звичайна заявка, якої дзеркало ще не
    // звʼязало з каноном (workShiftId і scheduledShiftPublicId обидва null),
    // НЕ має вважатись ручною — саме тут була помилка старої логіки
    // (перевірка порожнього workShiftId).
    it("звичайна заявка без requesterStaffId, workShiftId і scheduledShiftPublicId НЕ вважається ручною", async () => {
        const request: any = {
            id: "request-plain-1",
            requesterStaffId: null,
            workShiftId: null,
            scheduledShiftPublicId: null,
            isManual: false,
            locationId: "loc-1",
            city: "Київ",
            shiftDate: new Date("2030-05-10T00:00:00.000Z"),
            shiftStartTime: new Date("2030-05-10T12:00:00.000Z"),
            shiftEndTime: new Date("2030-05-10T20:00:00.000Z"),
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            awsReplacementPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            requester: null,
            replacement: null,
        };

        prismaMock.replacementRequest.findUnique.mockImplementation(async () => ({ ...request }));
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.update.mockResolvedValue({});

        const { ReplacementService } = await import("../replacement-service.js");
        await new ReplacementService().dispatchNextWave(api, request.id);

        const call = prismaMock.replacementResponse.findMany.mock.calls.find(
            ([args]: any) => args?.where?.request
        );
        expect(call).toBeDefined();
        const requestFilter = call![0].where.request;
        expect(requestFilter.OR).not.toContainEqual(
            expect.objectContaining({ isManual: true })
        );
        expect(requestFilter.OR).not.toContainEqual(
            expect.objectContaining({ workShiftId: null })
        );
    });
});
