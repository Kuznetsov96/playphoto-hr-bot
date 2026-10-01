import { describe, expect, it } from "vitest";
import { ReplacementRequestStatus } from "@prisma/client";
import { mergeStaffScheduleView } from "../staff-schedule-view-model.js";

const location = { id: "location-1", name: "Fantasy Town", schedule: "10:00-20:00" };
const shiftDate = new Date("2030-05-12T00:00:00.000Z");
const scheduledShift = {
    id: "shift-1",
    scheduledShiftPublicId: "canonical-shift-1",
    staffId: "staff-1",
    locationId: location.id,
    date: shiftDate,
    startTime: new Date("2030-05-12T07:00:00.000Z"),
    endTime: new Date("2030-05-12T17:00:00.000Z"),
    location
};

function outgoingRequest(
    status: ReplacementRequestStatus,
    scheduledShiftPublicId: string | null = scheduledShift.scheduledShiftPublicId
) {
    return {
        id: "request-1",
        scheduledShiftPublicId,
        requesterStaffId: "staff-1",
        replacementStaffId: status === ReplacementRequestStatus.FOUND ? "replacement-staff" : null,
        locationId: location.id,
        shiftDate,
        shiftStartTime: scheduledShift.startTime,
        shiftEndTime: scheduledShift.endTime,
        status,
        location
    };
}

describe("staff schedule replacement state", () => {
    it("keeps the original shift visible while replacement search is active", () => {
        const result = mergeStaffScheduleView(
            "staff-1",
            [scheduledShift],
            [],
            [outgoingRequest(ReplacementRequestStatus.ACTIVE)],
            100
        );

        expect(result).toEqual([
            expect.objectContaining({
                id: scheduledShift.id,
                isReplacementSearchActive: true
            })
        ]);
    });

    it("uses the request snapshot if the underlying shift is temporarily missing", () => {
        const result = mergeStaffScheduleView(
            "staff-1",
            [],
            [],
            [outgoingRequest(ReplacementRequestStatus.ACTIVE, null)],
            100
        );

        expect(result).toEqual([
            expect.objectContaining({
                id: "replacement-request:request-1",
                staffId: "staff-1",
                isReplacementSearchActive: true
            })
        ]);
    });

    it("removes the original shift only after another photographer accepts it", () => {
        const result = mergeStaffScheduleView(
            "staff-1",
            [scheduledShift],
            [],
            [outgoingRequest(ReplacementRequestStatus.FOUND)],
            100
        );

        expect(result).toEqual([]);
    });

    it("shows an accepted replacement before the main schedule is synchronized", () => {
        const result = mergeStaffScheduleView(
            "replacement-staff",
            [],
            [{
                id: "request-1",
                requesterStaffId: "staff-1",
                replacementStaffId: "replacement-staff",
                locationId: location.id,
                shiftDate,
                shiftStartTime: scheduledShift.startTime,
                shiftEndTime: scheduledShift.endTime,
                location
            }],
            [],
            100
        );

        expect(result).toEqual([
            expect.objectContaining({
                id: "replacement:request-1",
                staffId: "replacement-staff",
                isAcceptedReplacementPendingSync: true
            })
        ]);
    });

    it("hides an accepted replacement superseded by a third photographer in the main schedule", () => {
        const acceptedAssignment = {
            id: "request-1",
            requesterStaffId: "original-staff",
            replacementStaffId: "replacement-staff",
            locationId: location.id,
            shiftDate,
            shiftStartTime: scheduledShift.startTime,
            shiftEndTime: scheduledShift.endTime,
            location
        };

        const result = mergeStaffScheduleView(
            "replacement-staff",
            [],
            [acceptedAssignment],
            [],
            100,
            [{
                id: "shift-third-person",
                staffId: "third-staff",
                locationId: location.id,
                date: shiftDate
            }]
        );

        expect(result).toEqual([]);
    });
});

describe("staff schedule replacement state from the canonical schedule", () => {
    const canonicalRequest = (status: ReplacementRequestStatus) => ({
        ...outgoingRequest(status),
        awsReplacementPublicId: "aws-request-1"
    });

    it("does not resurrect a shift already given away while the local copy still says ACTIVE", () => {
        // Dragon Park 2, 30.09.2026: вебапп віддав зміну іншій, канонічний графік
        // її вже не містить, а локальна копія заявки ще ACTIVE.
        const result = mergeStaffScheduleView(
            "staff-1",
            [],
            [],
            [canonicalRequest(ReplacementRequestStatus.ACTIVE)],
            100,
            [],
            { canonicalSchedule: true }
        );

        expect(result).toEqual([]);
    });

    it("drops the search badge when the backend says the search is over", () => {
        // Dragon Park 2, 29.09.2026: пошук у вебаппі FAILED, зміна лишилась за нею.
        const result = mergeStaffScheduleView(
            "staff-1",
            [{ ...scheduledShift, replacementSearchActive: false }],
            [],
            [canonicalRequest(ReplacementRequestStatus.ACTIVE)],
            100,
            [],
            { canonicalSchedule: true }
        );

        expect(result).toEqual([
            expect.not.objectContaining({ isReplacementSearchActive: true })
        ]);
        expect(result).toHaveLength(1);
    });

    it("shows the search badge the backend reports even without a local request", () => {
        const result = mergeStaffScheduleView(
            "staff-1",
            [{ ...scheduledShift, replacementSearchActive: true }],
            [],
            [],
            100,
            [],
            { canonicalSchedule: true }
        );

        expect(result).toEqual([
            expect.objectContaining({ id: scheduledShift.id, isReplacementSearchActive: true })
        ]);
    });

    it("keeps a shift the local copy calls FOUND when the backend still has it on her", () => {
        // Прийняття скасували в межах вікна: вебапп повернув зміну, копія ще FOUND.
        const result = mergeStaffScheduleView(
            "staff-1",
            [{ ...scheduledShift, replacementSearchActive: false }],
            [],
            [canonicalRequest(ReplacementRequestStatus.FOUND)],
            100,
            [],
            { canonicalSchedule: true }
        );

        expect(result).toHaveLength(1);
    });

    it("falls back to the local request when the backend does not send the flag yet", () => {
        const result = mergeStaffScheduleView(
            "staff-1",
            [scheduledShift],
            [],
            [outgoingRequest(ReplacementRequestStatus.ACTIVE)],
            100,
            [],
            { canonicalSchedule: true }
        );

        expect(result).toEqual([
            expect.objectContaining({ id: scheduledShift.id, isReplacementSearchActive: true })
        ]);
    });
});
