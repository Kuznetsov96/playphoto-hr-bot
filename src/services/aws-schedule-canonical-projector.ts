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

    return canonicalShifts.flatMap(shift => {
        const location = locationByPublicId.get(shift.locationPublicId);
        // Локація або змаплена, або ні — це налаштування, а не відставання, і воно
        // не залежить від щойно зробленої правки. Показати зміну, не назвавши куди
        // йти, гірше, ніж не показати нічого.
        if (!location) throw new CanonicalScheduleReadError("LOCATION_NOT_MAPPED");

        // А ось відсутня проєкція — саме відставання: дзеркало наздоганяє канон раз
        // на пʼять хвилин, тож одразу після правки графіка зміна вже є в каноні, але
        // рядка під неї ще немає. Раніше це кидало помилку, читання падало у
        // fallback на дзеркало, і фотографиня бачила СТАРИЙ графік цілком — той
        // випадок, коли сповіщення називало 22.08, а список під ним її не містив.
        //
        // Пропуск точніший: решта змін приходить із канону, тобто свіжа, і зникає
        // лише той рядок, якого дзеркало ще не бачило. Через кілька хвилин він
        // зʼявиться сам.
        //
        // Синтезувати id замість пропуску не можна: у нагадуваннях він працює
        // ключем дедуплікації в Redis (`shift-reminder:<дата>:<staff>:<shift.id>`),
        // і вигаданий id дав би фотографині друге нагадування про ту саму зміну.
        const projection = projectionByPublicId.get(shift.publicId);
        if (!projection) return [];

        return [{
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
        }];
    });
}
