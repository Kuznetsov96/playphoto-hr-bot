import { ReplacementRequestStatus } from "@prisma/client";
import {
    classifyAcceptedReplacement,
    getScheduleDateKey,
    type ScheduledShiftIdentity
} from "../../../services/replacement-schedule-state.js";

/**
 * `city` and `branch` are what tell same-named venues apart — four locations are named
 * "Smile Park" and three "Volkland", and the branchless ones (Fly Kids, Karamel) differ only
 * by city. Dropping them here is what made every schedule row read a bare, useless "Smile Park".
 * Both stay optional because legacy rows may predate the canonical sync.
 */
type ShiftLocation = {
    id: string;
    name: string;
    city?: string | null;
    branch?: string | null;
    schedule?: string | null;
};

type ScheduledShift = {
    id: string;
    staffId: string;
    locationId: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    location: ShiftLocation;
};

type ReplacementAssignment = {
    id: string;
    requesterStaffId: string | null;
    replacementStaffId: string | null;
    locationId: string;
    shiftDate: Date;
    shiftStartTime: Date | null;
    shiftEndTime: Date | null;
    location: ShiftLocation;
};

type OutgoingReplacementRequest = ReplacementAssignment & {
    workShiftId: string | null;
    status: ReplacementRequestStatus;
};

export type StaffShiftView = ScheduledShift & {
    isReplacementSearchActive?: boolean;
    isAcceptedReplacementPendingSync?: boolean;
};

function getShiftDateKey(date: Date) {
    return getScheduleDateKey(date);
}

function getShiftFallbackKey(locationId: string, date: Date) {
    return `${locationId}:${getShiftDateKey(date)}`;
}

export function mergeStaffScheduleView(
    staffId: string,
    scheduledShifts: ScheduledShift[],
    acceptedAssignments: ReplacementAssignment[],
    outgoingRequests: OutgoingReplacementRequest[],
    limit: number,
    scheduledAssignmentSlots: ScheduledShiftIdentity[] = scheduledShifts
): StaffShiftView[] {
    const outgoingByShiftId = new Map(
        outgoingRequests
            .filter(request => request.workShiftId)
            .map(request => [request.workShiftId!, request])
    );
    const activeByFallbackKey = new Map(
        outgoingRequests
            .filter(request => request.status === ReplacementRequestStatus.ACTIVE)
            .map(request => [getShiftFallbackKey(request.locationId, request.shiftDate), request])
    );
    const matchedActiveRequestIds = new Set<string>();

    const ownedShifts = scheduledShifts.flatMap<StaffShiftView>(shift => {
        const request = outgoingByShiftId.get(shift.id)
            ?? activeByFallbackKey.get(getShiftFallbackKey(shift.locationId, shift.date));

        if (request?.status === ReplacementRequestStatus.FOUND) return [];
        if (request?.status === ReplacementRequestStatus.ACTIVE) {
            matchedActiveRequestIds.add(request.id);
            return [{ ...shift, isReplacementSearchActive: true }];
        }
        return [shift];
    });

    // The request contains a snapshot of the shift. Keeping it in the view makes
    // the ownership rule explicit even if a schedule refresh briefly recreates
    // or removes the underlying WorkShift while the search is still active.
    const activeRequestSnapshots: StaffShiftView[] = outgoingRequests
        .filter(request =>
            request.status === ReplacementRequestStatus.ACTIVE
            && !matchedActiveRequestIds.has(request.id)
        )
        .map(request => ({
            id: request.workShiftId ?? `replacement-request:${request.id}`,
            staffId,
            locationId: request.locationId,
            date: request.shiftDate,
            startTime: request.shiftStartTime,
            endTime: request.shiftEndTime,
            location: request.location,
            isReplacementSearchActive: true
        }));

    const visibleShifts = [...ownedShifts, ...activeRequestSnapshots];
    const visibleDays = new Set(visibleShifts.map(shift => getShiftDateKey(shift.date)));
    const acceptedReplacementShifts: StaffShiftView[] = acceptedAssignments
        .filter(assignment => {
            if (classifyAcceptedReplacement(assignment, scheduledAssignmentSlots) !== "pending") {
                return false;
            }
            const dateKey = getShiftDateKey(assignment.shiftDate);
            if (visibleDays.has(dateKey)) return false;
            visibleDays.add(dateKey);
            return true;
        })
        .map(assignment => ({
            id: `replacement:${assignment.id}`,
            staffId,
            locationId: assignment.locationId,
            date: assignment.shiftDate,
            startTime: assignment.shiftStartTime,
            endTime: assignment.shiftEndTime,
            location: assignment.location,
            isAcceptedReplacementPendingSync: true
        }));

    return [...visibleShifts, ...acceptedReplacementShifts]
        .sort((left, right) => left.date.getTime() - right.date.getTime())
        .slice(0, limit);
}
