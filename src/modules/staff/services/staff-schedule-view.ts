import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { AWS_SCHEDULE_CANONICAL_READ_ENABLED } from "../../../config.js";
import { logBusinessEvent } from "../../../core/log-events.js";
import {
    awsScheduleCanonicalReadService,
    CanonicalScheduleReadError
} from "../../../services/aws-schedule-canonical-read.js";
import { awsScheduleShadowService } from "../../../services/aws-schedule-shadow.js";
import { replacementService } from "../../../services/replacement-service.js";
import { mergeStaffScheduleView, type StaffShiftView } from "./staff-schedule-view-model.js";

export type { StaffShiftView } from "./staff-schedule-view-model.js";

export async function getVisibleStaffShifts(
    staffId: string,
    since: Date,
    limit: number,
    options: { shadowRead?: boolean; canonicalRead?: boolean } = {}
): Promise<StaffShiftView[]> {
    const [acceptedAssignments, outgoingRequests] = await Promise.all([
        replacementService.listAcceptedAssignmentsForStaff(staffId, since, limit),
        replacementService.listOutgoingScheduleRequestsForStaff(staffId, since, limit)
    ]);

    let legacyScheduledShifts: Awaited<ReturnType<typeof workShiftRepository.findWithLocationForStaff>> | undefined;
    const readLegacySchedule = async () => {
        legacyScheduledShifts = await workShiftRepository.findWithLocationForStaff(staffId, since, limit);
        return legacyScheduledShifts;
    };

    let scheduledShifts;
    if (options.canonicalRead === true && AWS_SCHEDULE_CANONICAL_READ_ENABLED) {
        const startedAt = Date.now();
        try {
            scheduledShifts = await awsScheduleCanonicalReadService.findForStaff(staffId, since, limit);
            logBusinessEvent({
                event: "bot.aws_schedule_canonical_read.succeeded",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "aws-schedule-canonical-read",
                operation: "read",
                durationMs: Date.now() - startedAt,
                safeContext: { shiftCount: scheduledShifts.length, limit }
            });
        } catch (error) {
            scheduledShifts = await readLegacySchedule();
            logBusinessEvent({
                event: "bot.aws_schedule_canonical_read.fallback",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "fallback",
                reasonCode: error instanceof CanonicalScheduleReadError
                    ? error.reasonCode
                    : "CANONICAL_SCHEDULE_UNAVAILABLE",
                module: "aws-schedule-canonical-read",
                operation: "read",
                durationMs: Date.now() - startedAt,
                safeContext: {
                    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                    legacyShiftCount: scheduledShifts.length,
                    limit
                }
            });
        }
    } else {
        scheduledShifts = await readLegacySchedule();
    }

    const scheduledAssignmentSlots = await workShiftRepository.findForSlots(
        acceptedAssignments.map(assignment => ({
            locationId: assignment.locationId,
            date: assignment.shiftDate
        }))
    );

    if (options.shadowRead === true && legacyScheduledShifts) {
        awsScheduleShadowService.compareInBackground({
            staffId,
            since,
            limit,
            legacyShifts: legacyScheduledShifts
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
