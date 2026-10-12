/**
 * Кнопки під сповіщеннями про графік. Окремий модуль без залежностей, щоб і
 * диспетчер, і обробники читали одне значення без циклу імпортів.
 * Старі повідомлення в чатах лишаються з `staff_hub_nav` — той обробник живий.
 */
export const SCHEDULE_NOTIFICATION_SCHEDULE_CALLBACK = "sched_notif_schedule";
export const SCHEDULE_NOTIFICATION_REPLACEMENT_CALLBACK = "sched_notif_replacement";
