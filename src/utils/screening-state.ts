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
