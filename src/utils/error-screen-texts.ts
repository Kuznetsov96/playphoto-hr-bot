import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

type ErrorScreenUser = {
    adminRole?: string | null;
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
 *
 * Адмін — англійською (AGENTS.md), навіть якщо в нього є й профіль
 * співробітниці; раніше йому йшов текст кандидатки (аудит 09.10.2026).
 */
export function getErrorScreenTexts(dbUser: ErrorScreenUser): { generic: string; staleScreen: string; toast: string } {
    if (dbUser?.adminRole) {
        return {
            generic: ADMIN_TEXTS["admin-error-generic"],
            staleScreen: ADMIN_TEXTS["admin-error-stale-screen"],
            toast: ADMIN_TEXTS["admin-error-toast"],
        };
    }
    const toast = "Відбулася технічна помилка 🛠️";
    if (dbUser?.staffProfile?.isActive) {
        return {
            generic: STAFF_TEXTS["staff-error-generic"],
            staleScreen: STAFF_TEXTS["staff-error-stale-screen"],
            toast,
        };
    }
    return {
        generic: CANDIDATE_TEXTS["candidate-error-generic"],
        staleScreen: CANDIDATE_TEXTS["candidate-error-stale-screen"],
        toast,
    };
}
