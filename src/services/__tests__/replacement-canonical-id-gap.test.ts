import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    replacementRequest: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    staffProfile: { findUnique: vi.fn(), findMany: vi.fn() },
    location: { count: vi.fn(), findUnique: vi.fn() },
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

const startCanonicalReplacement = vi.fn();
vi.mock("../replacement-canonical.js", () => ({
    startCanonicalReplacement,
    dispatchCanonicalWave: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const api: any = { sendMessage: vi.fn().mockResolvedValue({}), editMessageText: vi.fn().mockResolvedValue({}) };

const CANON = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

/**
 * Зміна, якої синк ще не звʼязав з каноном: `awsScheduledShiftPublicId` порожній.
 * Саме на таких заявках новий унікальний індекс не діяв, бо в рядку не було
 * канонічного id, за яким його перевіряти.
 */
const unlinkedShift = {
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

describe("startRequest — канонічний id для незвʼязаної зміни", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.create.mockImplementation(async ({ data }: any) => ({
            id: "request-1", status: "ACTIVE", currentWave: null, nextWaveAt: null, ...data,
        }));
        prismaMock.replacementRequest.findUnique.mockResolvedValue(null);
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.workShift.findUnique.mockResolvedValue(unlinkedShift);
        prismaMock.staffProfile.findUnique.mockResolvedValue({ awsEmployeePublicId: "emp-1" });
    });

    it("до-резолвить канонічний id, коли в самій зміні його ще немає", async () => {
        // Резолвер шукає запасним шляхом «співробітниця + локація + день» і
        // знаходить зміну-двійника, яку синк уже звʼязав.
        prismaMock.workShift.findMany.mockImplementation(async (args: any) => {
            if (args?.where?.awsScheduledShiftPublicId?.not === null) {
                return [{ awsScheduledShiftPublicId: CANON }];
            }
            return [];
        });

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.scheduledShiftPublicId).toBe(CANON);
    });

    it("не падає, коли канонічний id знайти нема де", async () => {
        prismaMock.workShift.findMany.mockResolvedValue([]);

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.scheduledShiftPublicId).toBeNull();
    });
});
