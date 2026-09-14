import { CanonicalScheduleReadError, type CanonicalScheduledShift } from "./aws-schedule-canonical-projector.js";

export type SelectableShiftsSource = {
    shifts: CanonicalScheduledShift[];
    source: "canonical" | "mirror";
};

/**
 * `canonical` і `mirror` отримують від `readSelectableShiftsSource` одне й те
 * саме число (третій параметр функції нижче — `horizonDays`), але трактують
 * його по-різному: `mirror` розуміє це як справжню кількість днів горизонту,
 * а `canonical` — як `limit`, кількість рядків, так само як робить далі
 * `awsScheduleCanonicalReadService.findForStaff`. Це не спільна межа, а лише
 * число, яке зараз збігається; вікно дат для канону задає окрема константа
 * `MAX_SCHEDULE_WINDOW_DAYS` в `aws-schedule-canonical-read.ts`. Детальніше —
 * у докблоку `listSelectableShifts` в `replacement-service.ts`.
 */
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

/**
 * Прибирає зміни, по яких пошук підміни вже триває.
 *
 * Фільтр локальний і таким лишається: заявки живуть у нашій БД, канонічний
 * бекенд їх не бачить.
 *
 * **Важливо**: множество повинне містити лише справжні ID (`shift.id`), без `null`.
 * Заявка вказує на зміну канонічним `scheduledShiftPublicId`, який nullable, тож
 * викликальна сторона зобов'язана відфільтрувати `null` і змапити канонічний id
 * на локальний `shift.id` перед побудовою цієї множини.
 */
export function rejectShiftsWithActiveRequest(
    shifts: CanonicalScheduledShift[],
    blockedShiftIds: Set<string>
): CanonicalScheduledShift[] {
    return shifts.filter(shift => !blockedShiftIds.has(shift.id));
}
