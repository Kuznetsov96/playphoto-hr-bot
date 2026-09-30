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
    interviewInvitedAt?: Date | string | null;
    interviewSlot?: { startTime: Date | string } | null;
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
 * Чинне запрошення на співбесіду — те саме, що invite-reminder вважає
 * запрошенням, яке чекає запису. Лише з нього можна відмовитися кнопкою
 * «Не планую продовжувати».
 *
 * Кнопка живе в запрошенні й нагадуванні, а ці повідомлення лишаються в чаті
 * назавжди. 30.09.2026 кандидатка, яка вже чекала нових вікон (розсилка
 * «нові вікна» знімає interviewInvitedAt), натиснула її на нагадуванні
 * добової давності й закрила собі заявку.
 */
export function hasLiveInterviewInvitation(candidate: InterviewStateCandidate): boolean {
    return candidate.status === CandidateStatus.SCREENING &&
        Boolean(candidate.notificationSent) &&
        Boolean(candidate.interviewInvitedAt) &&
        !candidate.interviewSlotId;
}

/**
 * Має чинний запис на співбесіду, яким можна керувати: змінити час,
 * скасувати, відмовитися. Після співбесіди слот лишається прив'язаним, тож
 * сам слот нічого не доводить — вирішує статус.
 */
export function hasActiveInterviewBooking(candidate: InterviewStateCandidate, slotId: string): boolean {
    if (candidate.status !== CandidateStatus.INTERVIEW_SCHEDULED) return false;
    // «none» — екран статусу записаної без слота; при живому слоті такий
    // payload означав би відмову без звільнення слота.
    if (slotId === "none") return !candidate.interviewSlotId;
    return candidate.interviewSlotId === slotId;
}

/**
 * Співбесіда почалась: з моменту старту слота перенос і скасування вже не
 * пропонуються. 30.09.2026 кандидатка чекала HR з 15:15, о 15:31 натиснула
 * «Змінити час» — і зняла себе із запису, на який її от-от мали покликати.
 */
export function hasInterviewStarted(startTime: Date | string | null | undefined, now: Date = new Date()): boolean {
    if (!startTime) return false;
    return new Date(startTime).getTime() <= now.getTime();
}

/** Власний запис, що ще не почався: його можна обміняти на інший час. */
export function canRescheduleInterview(candidate: InterviewStateCandidate, now: Date = new Date()): boolean {
    if (candidate.status !== CandidateStatus.INTERVIEW_SCHEDULED || !candidate.interviewSlotId) return false;
    return !hasInterviewStarted(candidate.interviewSlot?.startTime, now);
}
