import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    replacementRequest: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
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
    },
};

const startCanonicalReplacement = vi.fn();

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
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock("../replacement-canonical.js", () => ({
    startCanonicalReplacement: (...args: unknown[]) => startCanonicalReplacement(...args),
}));

function buildShift(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: "shift-1",
        staffId: "requester-1",
        locationId: "location-1",
        date: new Date("2030-05-11T00:00:00.000Z"),
        startTime: new Date("2030-05-11T11:00:00.000Z"),
        endTime: new Date("2030-05-11T18:00:00.000Z"),
        location: { id: "location-1", name: "Dragon Park", city: "Львів", schedule: null },
        staff: {
            id: "requester-1",
            fullName: "Бланк Анастасія",
            user: { telegramId: 1164289764n },
        },
        ...overrides,
    };
}

const api = { sendMessage: vi.fn().mockResolvedValue({ chat: { id: 1 }, message_id: 1 }) };

describe("ReplacementService.startRequest canonical wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findUnique.mockResolvedValue(null);
    });

    it("flag OFF: never calls the canonical backend and still creates a local request", async () => {
        vi.doMock("../../config.js", () => ({ AWS_REPLACEMENTS_CANONICAL_ENABLED: false }));

        const shift = buildShift();
        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.replacementRequest.create.mockResolvedValue({ ...shift, id: "request-1" });

        const { ReplacementService } = await import("../replacement-service.js");
        const created = await new ReplacementService().startRequest(api as any, "requester-1", "shift-1");

        expect(startCanonicalReplacement).not.toHaveBeenCalled();
        expect(created.id).toBe("request-1");
        expect(prismaMock.replacementRequest.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                workShiftId: "shift-1",
                requesterStaffId: "requester-1",
                awsReplacementPublicId: null,
            }),
        });
    });

    it("flag ON + canonical success: persists the returned publicId on the local row", async () => {
        vi.doMock("../../config.js", () => ({ AWS_REPLACEMENTS_CANONICAL_ENABLED: true }));
        startCanonicalReplacement.mockResolvedValue({ ok: true, replacementPublicId: "aws-pub-123" });

        const shift = buildShift();
        prismaMock.workShift.findUnique.mockResolvedValue(shift);
        prismaMock.replacementRequest.create.mockResolvedValue({ ...shift, id: "request-2" });

        const { ReplacementService } = await import("../replacement-service.js");
        const created = await new ReplacementService().startRequest(api as any, "requester-1", "shift-1");

        expect(startCanonicalReplacement).toHaveBeenCalledWith({
            workShiftId: "shift-1",
            requesterStaffId: "requester-1",
            requesterTelegramId: "1164289764",
            locationId: "location-1",
            shiftDate: shift.date,
        });
        expect(created.id).toBe("request-2");
        expect(prismaMock.replacementRequest.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                awsReplacementPublicId: "aws-pub-123",
            }),
        });
    });

    it("flag ON + canonical failure: creates no local request and throws with the reason code", async () => {
        vi.doMock("../../config.js", () => ({ AWS_REPLACEMENTS_CANONICAL_ENABLED: true }));
        startCanonicalReplacement.mockResolvedValue({ ok: false, reasonCode: "EMPLOYEE_NOT_MAPPED" });

        const shift = buildShift();
        prismaMock.workShift.findUnique.mockResolvedValue(shift);

        const { ReplacementService } = await import("../replacement-service.js");
        await expect(new ReplacementService().startRequest(api as any, "requester-1", "shift-1"))
            .rejects.toThrow("CANONICAL_REPLACEMENT_FAILED:EMPLOYEE_NOT_MAPPED");

        expect(prismaMock.replacementRequest.create).not.toHaveBeenCalled();
    });

    it("admin-initiated request (requesterStaffId null) stays on the legacy path even with the flag ON", async () => {
        vi.doMock("../../config.js", () => ({ AWS_REPLACEMENTS_CANONICAL_ENABLED: true }));

        const location = { id: "location-9", city: "Київ" };
        prismaMock.location.findUnique.mockResolvedValue(location);
        prismaMock.workShift.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.create.mockResolvedValue({ id: "request-9" });

        const { ReplacementService } = await import("../replacement-service.js");
        const shiftDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await new ReplacementService().startAdminRequest(api as any, "location-9", shiftDate);

        expect(startCanonicalReplacement).not.toHaveBeenCalled();
        const createCall = prismaMock.replacementRequest.create.mock.calls[0]?.[0];
        expect(createCall.data).toMatchObject({ locationId: "location-9" });
        expect(createCall.data).not.toHaveProperty("requesterStaffId");
    });
});
