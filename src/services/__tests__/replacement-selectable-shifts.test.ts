import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: { findMany: vi.fn() },
    replacementRequest: { findMany: vi.fn() }
};

const canonicalRead = { findForStaff: vi.fn() };

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../aws-schedule-canonical-read.js", async () => {
    const actual = await vi.importActual<typeof import("../aws-schedule-canonical-projector.js")>(
        "../aws-schedule-canonical-projector.js"
    );
    return {
        awsScheduleCanonicalReadService: canonicalRead,
        CanonicalScheduleReadError: actual.CanonicalScheduleReadError
    };
});
vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: {
        getAvailabilityForDate: vi.fn(),
        getAvailabilityForDateFromSchedule: vi.fn(),
        getMonthlyScheduleSheetName: vi.fn()
    }
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { add: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const canonicalShift = (id: string, date: string) => ({
    id,
    staffId: "staff-1",
    locationId: "loc-1",
    date: new Date(`${date}T00:00:00.000Z`),
    startTime: new Date(`${date}T08:00:00.000Z`),
    endTime: new Date(`${date}T17:00:00.000Z`),
    location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
});

describe("listSelectableShifts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("будує список з канону, а не з дзеркала", async () => {
        canonicalRead.findForStaff.mockResolvedValue([
            canonicalShift("s-1", "2026-09-20"),
            canonicalShift("s-2", "2026-09-21")
        ]);
        const { replacementService } = await import("../replacement-service.js");

        const result = await replacementService.listSelectableShifts("staff-1");

        expect(result.map(row => row.id)).toEqual(["s-1", "s-2"]);
        expect(prismaMock.workShift.findMany).not.toHaveBeenCalled();
    });

    it("прибирає зміну, по якій пошук уже триває", async () => {
        canonicalRead.findForStaff.mockResolvedValue([
            canonicalShift("s-1", "2026-09-20"),
            canonicalShift("s-2", "2026-09-21")
        ]);
        prismaMock.replacementRequest.findMany.mockResolvedValue([{ workShiftId: "s-1" }]);
        const { replacementService } = await import("../replacement-service.js");

        const result = await replacementService.listSelectableShifts("staff-1");

        expect(result.map(row => row.id)).toEqual(["s-2"]);
    });

    it("падає на дзеркало з горизонтом у 62 дні, коли канон недоступний", async () => {
        canonicalRead.findForStaff.mockRejectedValue(new Error("boom"));
        const { replacementService } = await import("../replacement-service.js");

        await replacementService.listSelectableShifts("staff-1");

        const query = prismaMock.workShift.findMany.mock.calls[0]![0]! as any;
        expect(query.take).toBeUndefined();
        const spanDays = Math.round(
            (query.where.date.lte.getTime() - query.where.date.gte.getTime()) / 86_400_000
        );
        expect(spanDays).toBe(61);
    });

    it("відкидає рядок дзеркала без startTime, а не показує його з вигаданим часом", async () => {
        canonicalRead.findForStaff.mockRejectedValue(new Error("boom"));
        prismaMock.workShift.findMany.mockResolvedValue([
            {
                id: "s-1",
                staffId: "staff-1",
                locationId: "loc-1",
                date: new Date("2026-09-20T00:00:00.000Z"),
                startTime: new Date("2026-09-20T08:00:00.000Z"),
                endTime: new Date("2026-09-20T17:00:00.000Z"),
                location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
            },
            {
                id: "s-2",
                staffId: "staff-1",
                locationId: "loc-1",
                date: new Date("2026-09-21T00:00:00.000Z"),
                startTime: null,
                endTime: null,
                location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
            }
        ]);
        const { replacementService } = await import("../replacement-service.js");

        const result = await replacementService.listSelectableShifts("staff-1");

        expect(result.map(row => row.id)).toEqual(["s-1"]);
    });
});
