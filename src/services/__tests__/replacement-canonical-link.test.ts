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
    location: { count: vi.fn() },
    // `findUnique` потрібен резолверу: `startRequest` до-резолвить канонічний id,
    // коли в самій зміні він порожній.
    staffProfile: { findMany: vi.fn(), findUnique: vi.fn() },
    replacementResponse: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: any) => callback(prismaMock)),
};

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: {
        getAvailabilityForDate: vi.fn(),
        getAvailabilityForDateFromSchedule: vi.fn().mockResolvedValue(new Map()),
        getMonthlyScheduleSheetName: vi.fn().mockReturnValue("Вересень 2026"),
    },
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { add: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const api: any = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
};

describe("startRequest — канонічний ідентифікатор зміни", () => {
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
                location: { id: "loc-1", name: "Smile Park", city: "Київ" },
                requester: null,
                replacement: null,
            };
        });
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.staffProfile.findUnique.mockResolvedValue({ awsEmployeePublicId: "emp-1" });
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("пише канонічний id зміни як єдине посилання на неї", async () => {
        const shift = {
            id: "shift-1",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-10T00:00:00.000Z"),
            startTime: new Date("2030-05-10T08:00:00.000Z"),
            endTime: new Date("2030-05-10T17:00:00.000Z"),
            awsScheduledShiftPublicId: "11111111-1111-4111-8111-111111111111",
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        };
        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        // dispatchNextWave перевіряє, чи зміна досі стоїть у розкладі —
        // повертаємо ту саму зміну, щоб заявка не вважалась застарілою.
        prismaMock.workShift.findFirst.mockResolvedValue(shift);

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.scheduledShiftPublicId).toBe("11111111-1111-4111-8111-111111111111");
    });

    it("не падає, коли канонічний id не знайшов навіть резолвер", async () => {
        const shift = {
            id: "shift-2",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-11T00:00:00.000Z"),
            startTime: new Date("2030-05-11T08:00:00.000Z"),
            endTime: new Date("2030-05-11T17:00:00.000Z"),
            awsScheduledShiftPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        };
        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.workShift.findFirst.mockResolvedValue(shift);

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-2");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        // Ні в самій зміні, ні запасним шляхом резолвера id не знайшовся —
        // заявка все одно створюється, бо людина не має втратити можливість
        // попросити підміну через відставання синку.
        expect(created.scheduledShiftPublicId).toBeNull();
    });
});
