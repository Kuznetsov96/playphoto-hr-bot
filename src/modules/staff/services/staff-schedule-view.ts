import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { replacementService } from "../../../services/replacement-service.js";
import { mergeStaffScheduleView, type StaffShiftView } from "./staff-schedule-view-model.js";

export type { StaffShiftView } from "./staff-schedule-view-model.js";

export async function getVisibleStaffShifts(staffId: string, since: Date, limit: number): Promise<StaffShiftView[]> {
    const [scheduledShifts, acceptedAssignments, outgoingRequests] = await Promise.all([
        workShiftRepository.findWithLocationForStaff(staffId, since, limit),
        replacementService.listAcceptedAssignmentsForStaff(staffId, since, limit),
        replacementService.listOutgoingScheduleRequestsForStaff(staffId, since, limit)
    ]);

    return mergeStaffScheduleView(staffId, scheduledShifts, acceptedAssignments, outgoingRequests, limit);
}
