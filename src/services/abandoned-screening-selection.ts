/**
 * Отбор кандидаток, бросивших анкету, для однократного напоминания.
 *
 * Чистая функция вынесена из worker.ts сознательно: это правило («кого
 * догонять») меняется чаще остального вокера и должно проверяться без базы,
 * бота и таймеров.
 */

/** Сколько молчания считаем брошенной анкетой. */
export const ABANDONED_SCREENING_AFTER_MS = 24 * 60 * 60 * 1000;

export type AbandonedScreeningRow = {
    pipelineTouchedAt: Date;
    screeningReminderSentAt: Date | null;
};

/**
 * Кого догонять по брошенной анкете.
 *
 * Считаем от последней активности (`pipelineTouchedAt`), а НЕ от создания
 * Telegram-аккаунта: по `user.createdAt` в окне 24–48 часов кандидатка,
 * которую бот знал давно — вернулась сама, пришла по рассылке, — не попадала
 * в выборку никогда. На 03.09.2026 под напоминание не подпадали 376 из 420
 * анкет в SCREENING, из них 33 молчали дольше месяца.
 *
 * Однократность держит отметка `screeningReminderSentAt`, а не временное
 * окно: вокер крутится каждые 5 минут, и окно «от 24 до 25 часов» рассылало
 * бы повтор при каждом попадании в него.
 */
export function selectAbandonedScreeningCandidates<T extends AbandonedScreeningRow>(
    rows: readonly T[],
    now: Date,
): T[] {
    return rows.filter((row) => {
        if (row.screeningReminderSentAt !== null) return false;
        return now.getTime() - row.pipelineTouchedAt.getTime() >= ABANDONED_SCREENING_AFTER_MS;
    });
}
