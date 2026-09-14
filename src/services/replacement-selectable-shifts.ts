import { CanonicalScheduleReadError, type CanonicalScheduledShift } from "./aws-schedule-canonical-projector.js";

export type SelectableShiftsSource = {
    shifts: CanonicalScheduledShift[];
    source: "canonical" | "mirror";
};

export type SelectableShiftsDeps = {
    canonical: (staffId: string, since: Date, limit: number) => Promise<CanonicalScheduledShift[]>;
    mirror: (staffId: string, since: Date, horizonDays: number) => Promise<CanonicalScheduledShift[]>;
    log: (entry: { reasonCode: string; errorType: string }) => void;
};

/**
 * Звідки взяти зміни для екрана вибору підміни.
 *
 * Канон — основне джерело: екран має показувати те саме, що «Мій графік»,
 * інакше свіжа зміна видима в одному місці й недоступна в іншому.
 *
 * Дзеркало лишається запасним шляхом, бо перед екраном стоїть людина: краще
 * показати дані п'ятихвилинної давнини, ніж помилку. Мовчки, бо для неї ці
 * дані валідні — розходження цікаве нам, і воно йде в лог.
 */
export async function readSelectableShiftsSource(
    staffId: string,
    since: Date,
    horizonDays: number,
    deps: SelectableShiftsDeps
): Promise<SelectableShiftsSource> {
    try {
        return { shifts: await deps.canonical(staffId, since, horizonDays), source: "canonical" };
    } catch (error) {
        deps.log({
            reasonCode: error instanceof CanonicalScheduleReadError
                ? error.reasonCode
                : "CANONICAL_SCHEDULE_UNAVAILABLE",
            errorType: error instanceof Error ? error.constructor.name : "UnknownError"
        });
        return { shifts: await deps.mirror(staffId, since, horizonDays), source: "mirror" };
    }
}
