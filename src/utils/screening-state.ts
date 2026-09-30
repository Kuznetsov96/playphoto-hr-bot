import { CandidateStatus, FunnelStep } from "@prisma/client";

/**
 * Стан анкети кандидатки — одне правило для всіх входів у неї.
 *
 * До 30.09.2026 кожен вхід вирішував сам: екран статусу дивився на `source`,
 * реактивація — на повний набір полів, нагадування «лишилося кілька питань» —
 * лише на статус SCREENING, а кнопка «Продовжити анкету» не дивилась ні на
 * що. SCREENING при цьому означає три різні речі: анкета в процесі, анкета
 * закінчена й чекає запрошення, запрошена ще не записалась. Тож нагадування
 * отримали 252 кандидатки із закінченою анкетою за місяць, а кнопка в ньому
 * перераховувала статус навіть записаним на співбесіду.
 */
export type ScreeningStateCandidate = {
    status: CandidateStatus;
    currentStep?: FunnelStep | null;
    notificationSent?: boolean | null;
    fullName?: string | null;
    gender?: string | null;
    birthDate?: Date | string | null;
    city?: string | null;
    locationId?: string | null;
    appearance?: string | null;
    source?: string | null;
};

/** Усі відповіді анкети на місці. `source` пишеться лише фіналом анкети. */
export function isScreeningComplete(candidate: ScreeningStateCandidate): boolean {
    return Boolean(
        candidate.fullName &&
        candidate.gender &&
        candidate.birthDate &&
        candidate.city &&
        candidate.locationId &&
        candidate.appearance &&
        candidate.source
    );
}

/**
 * Анкету ще заповнюють: саме тоді доречні «Продовжити анкету», «Почати
 * спочатку» й нагадування про покинуту анкету. Будь-що інше — закінчена
 * анкета, запрошення, співбесіда, відмова — має показувати статус, а не
 * повертати людину до питань.
 */
export function isQuestionnaireOpen(candidate: ScreeningStateCandidate): boolean {
    if (candidate.status !== CandidateStatus.SCREENING) return false;
    if (candidate.currentStep && candidate.currentStep !== FunnelStep.INITIAL_TEST) return false;
    if (candidate.notificationSent) return false;
    return !isScreeningComplete(candidate);
}

export type InterviewStateCandidate = {
    status: CandidateStatus;
    currentStep?: FunnelStep | null;
    notificationSent?: boolean | null;
    interviewSlotId?: string | null;
};

const RESCHEDULING_STATUSES: ReadonlySet<CandidateStatus> = new Set([
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST_HR,
    CandidateStatus.WAITLIST,
]);

/**
 * Може обрати час співбесіди: запрошена (SCREENING + notificationSent) або
 * вже була в записі й шукає новий час — скасувала, переносить, не знайшла
 * вікна (currentStep INTERVIEW). Кнопки старого запрошення після скидання
 * через 48 год («місце перейшло іншому») сюди не проходять.
 */
export function canScheduleInterview(candidate: InterviewStateCandidate): boolean {
    if (candidate.interviewSlotId) return false;
    if (candidate.status === CandidateStatus.SCREENING && candidate.notificationSent) return true;
    return candidate.currentStep === FunnelStep.INTERVIEW && RESCHEDULING_STATUSES.has(candidate.status);
}

/**
 * Має чинний запис на співбесіду, яким можна керувати: змінити час,
 * скасувати, відмовитися. Після співбесіди слот лишається прив'язаним, тож
 * сам слот нічого не доводить — вирішує статус.
 */
export function hasActiveInterviewBooking(candidate: InterviewStateCandidate, slotId: string): boolean {
    if (candidate.status !== CandidateStatus.INTERVIEW_SCHEDULED) return false;
    return slotId === "none" || candidate.interviewSlotId === slotId;
}
