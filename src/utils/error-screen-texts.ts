import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

type ErrorScreenUser = {
    staffProfile?: { isActive?: boolean | null } | null;
} | null | undefined;

/**
 * Тексти загального екрана збою (core/bot.ts) за роллю.
 *
 * Екран бачать і кандидатки, і співробітниці, а звертання в них різне: до
 * кандидатки на «ви», до своїх — на «ти». Своя — та, в кого є активний
 * профіль співробітниці; так роль визначають /start і підтримка
 * (handlers/commands.ts, handlers/support.ts). Без dbUser (не завантажився)
 * — нейтральніше «ви». Аудит 01.10.2026, тексти погоджено власником.
 */
export function getErrorScreenTexts(dbUser: ErrorScreenUser): { generic: string; staleScreen: string } {
    if (dbUser?.staffProfile?.isActive) {
        return {
            generic: STAFF_TEXTS["staff-error-generic"],
            staleScreen: STAFF_TEXTS["staff-error-stale-screen"],
        };
    }
    return {
        generic: CANDIDATE_TEXTS["candidate-error-generic"],
        staleScreen: CANDIDATE_TEXTS["candidate-error-stale-screen"],
    };
}
