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
    /** Канонічний id тієї ж зміни; `null` для рядків дзеркала, яких синк ще не звʼязав з каноном. */
    scheduledShiftPublicId?: string | null;
    staffId: string;
    locationId: string;
    date: Date;
    startTime: Date | null;
    endTime: Date | null;
    location: ShiftLocation;
    /**
     * Чи йде пошук підміни на цю зміну — за словами вебаппа. Є лише в зміні з
     * канонічного читання і лише коли бекенд уже віддає це поле; `undefined`
     * означає «невідомо», і тоді рішення лишається за локальною заявкою.
     */
    replacementSearchActive?: boolean;
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
    scheduledShiftPublicId: string | null;
    status: ReplacementRequestStatus;
    /** Є у заявки, яку веде вебапп; `null` — у старої локальної. */
    awsReplacementPublicId?: string | null;
};

export type StaffScheduleViewOptions = {
    /**
     * Графік прочитано з вебаппа, а не з дзеркала. Тоді стан канонічних заявок
     * бот не вгадує за своєю копією: та закривається із запізненням або не
     * закривається зовсім, і фотографиня бачила «шукаємо підміну — зміна поки
     * твоя» на зміні, яку вже віддали іншій (Dragon Park 2, 30.09.2026).
     */
    canonicalSchedule?: boolean;
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
    scheduledAssignmentSlots: ScheduledShiftIdentity[] = scheduledShifts,
    options: StaffScheduleViewOptions = {}
): StaffShiftView[] {
    // Канонічний графік уже каже, чия зміна: віддану зміну він не містить, а
    // зміна після скасованої чи невдалої підміни лишається на місці. Локальна
    // копія канонічної заявки тут може лише збрехати, тож її не враховуємо.
    // Старі локальні заявки (без awsReplacementPublicId) вебапп не знає —
    // для них правило лишається колишнім.
    if (options.canonicalSchedule) {
        outgoingRequests = outgoingRequests.filter(request => !request.awsReplacementPublicId);
    }

    // Заявка тримається за зміну канонічним id, тож і зіставлення йде по
    // ньому: локального посилання на рядок дзеркала в заявці більше немає.
    const outgoingByCanonicalShiftId = new Map(
        outgoingRequests
            .filter(request => request.scheduledShiftPublicId)
            .map(request => [request.scheduledShiftPublicId!, request])
    );
    const activeByFallbackKey = new Map(
        outgoingRequests
            .filter(request => request.status === ReplacementRequestStatus.ACTIVE)
            .map(request => [getShiftFallbackKey(request.locationId, request.shiftDate), request])
    );
    const matchedActiveRequestIds = new Set<string>();

    const ownedShifts = scheduledShifts.flatMap<StaffShiftView>(shift => {
        if (shift.replacementSearchActive === true) {
            return [{ ...shift, isReplacementSearchActive: true }];
        }
        if (shift.replacementSearchActive === false) return [shift];

        const request = (shift.scheduledShiftPublicId
            ? outgoingByCanonicalShiftId.get(shift.scheduledShiftPublicId)
            : undefined)
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
            id: `replacement-request:${request.id}`,
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
