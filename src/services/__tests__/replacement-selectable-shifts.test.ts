import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: {
        findMany: vi.fn(),
    },
};

vi.mock("../../db/core.js", () => ({
    default: prismaMock,
}));

vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: {
        getAvailabilityForDate: vi.fn(),
        getAvailabilityForDateFromSchedule: vi.fn(),
        getMonthlyScheduleSheetName: vi.fn(),
    },
}));

vi.mock("../../core/queue.js", () => ({
    defaultQueue: { add: vi.fn() },
}));

vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Фотографиня має бачити всі свої майбутні зміни, а не перші дванадцять.
 * Горизонт обмежує дата, а не кількість рядків: 62 дні — рівно те вікно,
 * яке віддає канонічний бекенд, тож список не може обірватися раніше за канон.
 */
describe("listSelectableShifts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("обмежує вибірку горизонтом дат, а не кількістю змін", async () => {
        const { replacementService } = await import("../replacement-service.js");

        await replacementService.listSelectableShifts("staff-1");

        const query = prismaMock.workShift.findMany.mock.calls[0]![0]! as any;
        expect(query.take).toBeUndefined();
        expect(query.where.date.gte).toBeInstanceOf(Date);
        expect(query.where.date.lte).toBeInstanceOf(Date);

        const spanDays = Math.round(
            (query.where.date.lte.getTime() - query.where.date.gte.getTime()) / 86_400_000
        );
        expect(spanDays).toBe(61);
    });
});
