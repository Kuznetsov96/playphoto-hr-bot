import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { awsScheduleShadowService } from "../../../services/aws-schedule-shadow.js";
import { replacementService } from "../../../services/replacement-service.js";
import { mergeStaffScheduleView, type StaffShiftView } from "./staff-schedule-view-model.js";

export type { StaffShiftView } from "./staff-schedule-view-model.js";

export async function getVisibleStaffShifts(
    staffId: string,
    since: Date,
    limit: number,
    options: { shadowRead?: boolean } = {}
): Promise<StaffShiftView[]> {
    const [scheduledShifts, acceptedAssignments, outgoingRequests] = await Promise.all([
        workShiftRepository.findWithLocationForStaff(staffId, since, limit),
        replacementService.listAcceptedAssignmentsForStaff(staffId, since, limit),
        replacementService.listOutgoingScheduleRequestsForStaff(staffId, since, limit)
    ]);

    const scheduledAssignmentSlots = await workShiftRepository.findForSlots(
        acceptedAssignments.map(assignment => ({
            locationId: assignment.locationId,
            date: assignment.shiftDate
        }))
    );

    if (options.shadowRead === true) {
        awsScheduleShadowService.compareInBackground({
            staffId,
            since,
            limit,
            legacyShifts: scheduledShifts
        });
    }

    return mergeStaffScheduleView(
        staffId,
        scheduledShifts,
        acceptedAssignments,
        outgoingRequests,
        limit,
        scheduledAssignmentSlots
    );
}
