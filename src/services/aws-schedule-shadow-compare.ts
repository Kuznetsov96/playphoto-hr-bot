import type { Location, WorkShift } from "@prisma/client";
import type { AwsEmployeeSchedule } from "./aws-business-client.js";

export type LegacyScheduleShift = WorkShift & { location: Location };
type CanonicalShift = AwsEmployeeSchedule["shifts"][number];

export interface ScheduleShadowComparison {
    parity: boolean;
    legacyCount: number;
    canonicalCount: number;
    matchedCount: number;
    changedCount: number;
    missingInCanonicalCount: number;
    missingInLegacyCount: number;
    unmappedLegacyCount: number;
}

export function compareScheduleProjection(
    legacyShifts: LegacyScheduleShift[],
    canonicalShifts: CanonicalShift[]
): ScheduleShadowComparison {
    const legacyByPublicId = new Map(
        legacyShifts.flatMap((shift) =>
            shift.awsScheduledShiftPublicId ? [[shift.awsScheduledShiftPublicId, shift] as const] : []
        )
    );
    const canonicalByPublicId = new Map(canonicalShifts.map((shift) => [shift.publicId, shift]));
    let matchedCount = 0;
    let changedCount = 0;
    let missingInCanonicalCount = 0;

    for (const [publicId, legacy] of legacyByPublicId) {
        const canonical = canonicalByPublicId.get(publicId);
        if (!canonical) {
            missingInCanonicalCount += 1;
            continue;
        }
        if (sameShift(legacy, canonical)) matchedCount += 1;
        else changedCount += 1;
    }

    const missingInLegacyCount = canonicalShifts.filter((shift) => !legacyByPublicId.has(shift.publicId)).length;
    const unmappedLegacyCount = legacyShifts.length - legacyByPublicId.size;
    const parity =
        changedCount === 0 && missingInCanonicalCount === 0 && missingInLegacyCount === 0 && unmappedLegacyCount === 0;

    return {
        parity,
        legacyCount: legacyShifts.length,
        canonicalCount: canonicalShifts.length,
        matchedCount,
        changedCount,
        missingInCanonicalCount,
        missingInLegacyCount,
        unmappedLegacyCount
    };
}

function sameShift(legacy: LegacyScheduleShift, canonical: CanonicalShift): boolean {
    return (
        legacy.location.awsPublicId === canonical.locationPublicId &&
        legacy.date.toISOString().slice(0, 10) === canonical.localDate &&
        legacy.startTime?.toISOString() === canonical.startsAt &&
        legacy.endTime?.toISOString() === canonical.endsAt
    );
}
