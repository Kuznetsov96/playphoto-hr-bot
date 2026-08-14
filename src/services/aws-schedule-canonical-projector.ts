import type { AwsEmployeeSchedule } from "./aws-business-client.js";

type CanonicalShift = AwsEmployeeSchedule["shifts"][number];

export type LocalScheduleLocation = {
    id: string;
    awsPublicId: string | null;
    name: string;
    city?: string | null;
    branch?: string | null;
    schedule: string | null;
    openingHours?: { dayOfWeek: number; opens: string; closes: string }[];
};

export type LocalShiftProjection = {
    id: string;
    awsScheduledShiftPublicId: string | null;
};

export type CanonicalScheduledShift = {
    id: string;
    staffId: string;
    locationId: string;
    date: Date;
    startTime: Date;
    endTime: Date;
    location: Pick<LocalScheduleLocation, "id" | "name" | "city" | "branch" | "schedule" | "openingHours">;
};

export type CanonicalScheduleReadReason =
    | "EMPLOYEE_NOT_MAPPED"
    | "LOCATION_NOT_MAPPED"
    | "SHIFT_PROJECTION_NOT_MAPPED";

export class CanonicalScheduleReadError extends Error {
    constructor(public readonly reasonCode: CanonicalScheduleReadReason) {
        super(reasonCode);
        this.name = "CanonicalScheduleReadError";
    }
}

export function projectCanonicalSchedule(
    staffId: string,
    canonicalShifts: CanonicalShift[],
    locations: LocalScheduleLocation[],
    projections: LocalShiftProjection[]
): CanonicalScheduledShift[] {
    const locationByPublicId = new Map(
        locations.flatMap(location => location.awsPublicId ? [[location.awsPublicId, location] as const] : [])
    );
    const projectionByPublicId = new Map(
        projections.flatMap(projection => projection.awsScheduledShiftPublicId
            ? [[projection.awsScheduledShiftPublicId, projection] as const]
            : [])
    );

    return canonicalShifts.map(shift => {
        const location = locationByPublicId.get(shift.locationPublicId);
        if (!location) throw new CanonicalScheduleReadError("LOCATION_NOT_MAPPED");
        const projection = projectionByPublicId.get(shift.publicId);
        if (!projection) throw new CanonicalScheduleReadError("SHIFT_PROJECTION_NOT_MAPPED");

        return {
            id: projection.id,
            staffId,
            locationId: location.id,
            date: new Date(`${shift.localDate}T00:00:00.000Z`),
            startTime: new Date(shift.startsAt),
            endTime: new Date(shift.endsAt),
            location: {
                id: location.id,
                name: location.name,
                city: location.city ?? null,
                branch: location.branch ?? null,
                schedule: location.schedule,
                openingHours: location.openingHours ?? []
            }
        };
    });
}
