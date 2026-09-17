import { STAFF_TEXTS } from "../constants/staff-texts.js";

/**
 * Єдиний білдер сповіщення про нове завдання, спільний для трьох майстрів
 * постановки задач (дашборд, профіль співробітниці, масова розсилка). Раніше
 * кожен майстер збирав текст самостійно, і той самий факт "тобі поставили
 * завдання" звучав по-різному залежно від того, яким адмінським екраном
 * скористалися — це і є розбіжність A з аудиту вирівнювання.
 *
 * `date` приймається вже відформатованою рядком (кожен викликач формує дату
 * по-своєму — з `workDate` чи з локального рядка), щоб цей модуль не тягнув
 * додаткових залежностей форматування дат.
 */
export function buildTaskNotificationText(params: {
    text: string;
    date: string;
    deadlineTime?: string | null | undefined;
    completionMode?: "QUICK" | "PROOF_REQUIRED" | string | null | undefined;
}): string {
    return STAFF_TEXTS["staff-task-notification"]({
        text: params.text,
        date: params.date,
        deadlineTime: params.deadlineTime ?? null,
        completionHint: params.completionMode === "PROOF_REQUIRED",
    });
}

/**
 * callback_data кнопки під сповіщенням про нове завдання: веде одразу в
 * "Мої завдання", а не в загальне меню — фотографині це заощаджує зайвий тап.
 */
export const TASK_NOTIFICATION_BUTTON_CALLBACK = "staff_hub_tasks_redirect";

export function taskNotificationButtonLabel(): string {
    return STAFF_TEXTS["staff-task-notification-btn-tasks"];
}
