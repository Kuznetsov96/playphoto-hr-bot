import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    canonicalRead: vi.fn(),
    legacyRead: vi.fn(),
    acceptedAssignments: vi.fn(),
    outgoingRequests: vi.fn(),
    assignmentSlots: vi.fn(),
    shadowCompare: vi.fn(),
    logEvent: vi.fn()
}));

vi.mock("../../../../config.js", () => ({ AWS_SCHEDULE_CANONICAL_READ_ENABLED: true }));
vi.mock("../../../../core/log-events.js", () => ({ logBusinessEvent: mocks.logEvent }));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: {
        findWithLocationForStaff: mocks.legacyRead,
        findForSlots: mocks.assignmentSlots
    }
}));
vi.mock("../../../../services/replacement-service.js", () => ({
    replacementService: {
        listAcceptedAssignmentsForStaff: mocks.acceptedAssignments,
        listOutgoingScheduleRequestsForStaff: mocks.outgoingRequests
    }
}));
vi.mock("../../../../services/aws-schedule-shadow.js", () => ({
    awsScheduleShadowService: { compareInBackground: mocks.shadowCompare }
}));
vi.mock("../../../../services/aws-schedule-canonical-read.js", () => {
    class CanonicalScheduleReadError extends Error {
        constructor(public readonly reasonCode: string) {
            super(reasonCode);
        }
    }
    return {
        CanonicalScheduleReadError,
        awsScheduleCanonicalReadService: { findForStaff: mocks.canonicalRead }
    };
});

import { getVisibleStaffShifts } from "../staff-schedule-view.js";

const location = { id: "location-1", name: "Mapped location", schedule: "10:00-20:00" };
const canonicalShift = {
    id: "local-technical-shift-id",
    staffId: "staff-1",
    locationId: location.id,
    date: new Date("2030-05-12T00:00:00.000Z"),
    startTime: new Date("2030-05-12T07:00:00.000Z"),
    endTime: new Date("2030-05-12T17:00:00.000Z"),
    location
};
const legacyShift = {
    ...canonicalShift,
    startTime: new Date("2030-05-12T08:00:00.000Z"),
    awsScheduledShiftPublicId: "33333333-3333-4333-8333-333333333333"
};

describe("staff schedule source selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.acceptedAssignments.mockResolvedValue([]);
        mocks.outgoingRequests.mockResolvedValue([]);
        mocks.assignmentSlots.mockResolvedValue([]);
        mocks.legacyRead.mockResolvedValue([legacyShift]);
    });

    it("uses canonical business fields as the primary schedule", async () => {
        mocks.canonicalRead.mockResolvedValue([canonicalShift]);

        const result = await getVisibleStaffShifts("staff-1", new Date("2030-05-12"), 100, {
            canonicalRead: true,
            shadowRead: true
        });

        expect(result).toEqual([canonicalShift]);
        expect(mocks.legacyRead).not.toHaveBeenCalled();
        expect(mocks.shadowCompare).not.toHaveBeenCalled();
        expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: "bot.aws_schedule_canonical_read.succeeded",
            result: "success"
        }));
    });

    it("falls back atomically to the legacy projection when canonical read fails", async () => {
        mocks.canonicalRead.mockRejectedValue(new Error("backend unavailable"));

        const result = await getVisibleStaffShifts("staff-1", new Date("2030-05-12"), 100, {
            canonicalRead: true,
            shadowRead: true
        });

        expect(result).toEqual([legacyShift]);
        expect(mocks.legacyRead).toHaveBeenCalledOnce();
        expect(mocks.shadowCompare).toHaveBeenCalledWith(expect.objectContaining({
            legacyShifts: [legacyShift]
        }));
        expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: "bot.aws_schedule_canonical_read.fallback",
            result: "fallback",
            reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE"
        }));
    });
});
