import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * На проді `AWS_REPLACEMENTS_CANONICAL_ENABLED=true`, тож у `startRequest`
 * працює канонічна гілка. Прапорець читається один раз при імпорті модуля,
 * тому підміняємо його на рівні файла — без `resetModules`, який ламав би
 * сусідні тестові файли через спільний стан модулів.
 */
vi.mock("../../config.js", async () => {
    const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
    return { ...actual, AWS_REPLACEMENTS_CANONICAL_ENABLED: true };
});

const prismaMock = {
    workShift: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    replacementRequest: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    staffProfile: { findUnique: vi.fn(), findMany: vi.fn() },
    location: { count: vi.fn(), findUnique: vi.fn() },
    replacementResponse: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: any) => callback(prismaMock)),
};

const startCanonicalReplacement = vi.fn();

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../replacement-canonical.js", () => ({
    startCanonicalReplacement,
    dispatchCanonicalWave: vi.fn().mockResolvedValue({ ok: true }),
}));
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

const api: any = { sendMessage: vi.fn().mockResolvedValue({}), editMessageText: vi.fn().mockResolvedValue({}) };
const CANON = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

describe("startRequest із увімкненим канонічним прапорцем", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.findUnique.mockResolvedValue(null);
        prismaMock.replacementRequest.create.mockImplementation(async ({ data }: any) => ({
            id: "request-1", status: "ACTIVE", currentWave: null, nextWaveAt: null, ...data,
        }));
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.staffProfile.findUnique.mockResolvedValue({ awsEmployeePublicId: "emp-1" });
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.workShift.findUnique.mockResolvedValue({
            id: "shift-1",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-10T00:00:00.000Z"),
            startTime: new Date("2030-05-10T08:00:00.000Z"),
            endTime: new Date("2030-05-10T17:00:00.000Z"),
            // Синк ще не звʼязав зміну з каноном.
            awsScheduledShiftPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        });
        startCanonicalReplacement.mockResolvedValue({
            ok: true,
            replacementPublicId: "repl-1",
            scheduledShiftPublicId: CANON,
        });
    });

    it("пише канонічний id, який повернув канонічний шлях, а не порожнє поле зміни", async () => {
        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.scheduledShiftPublicId).toBe(CANON);
    });
});
