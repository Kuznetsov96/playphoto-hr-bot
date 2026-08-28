/**
 * Запас до контрактных 500: ack-клиент дорежет по контракту сам, но причина,
 * которую увидит рекрутёр, не должна обрываться на полуслове.
 */
const MAX_ERROR_LENGTH = 450;

/**
 * Сводит любую ошибку применения к короткой строке для карточки рекрутёра.
 * Код воронки (`reasonCode` у InvalidCandidateTransitionError, `code` у
 * AwsBusinessApiError) идёт первым — это то, по чему диагностируют; текст —
 * следом, для человека.
 *
 * Вынесено из recruiting-command-dispatcher, чтобы доставка сообщений и
 * рассылки (фаза 3b) могли использовать тот же формат без цикла импортов.
 */
export function describeCommandFailure(error: unknown): string {
    if (error instanceof Error) {
        const carrier = error as { reasonCode?: unknown; code?: unknown };
        const code = typeof carrier.reasonCode === "string"
            ? carrier.reasonCode
            : typeof carrier.code === "string" ? carrier.code : null;
        const text = code && code !== error.message ? `${code}: ${error.message}` : (code ?? error.message);
        return text.slice(0, MAX_ERROR_LENGTH);
    }
    return String(error).slice(0, MAX_ERROR_LENGTH);
}
