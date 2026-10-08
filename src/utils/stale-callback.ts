/**
 * Захист від застарілих кнопок співробітниці: відомі префікси пропускаються, решта
 * в приватному чаті вважається кнопкою зі старого меню. У групі захист не працює:
 * він видаляє повідомлення з кнопкою — у чаті підтримки це була б закріплена картка.
 */
export function isKnownCallback(data: string): boolean {
    return data.startsWith("sth:") ||
        data.startsWith("cb:") ||
        data.startsWith("staff_") || data.startsWith("staff-") || data.startsWith("admin_") || data.startsWith("admin-") ||
        data.startsWith("hr_") || data.startsWith("hr-") ||
        data.startsWith("mentor_") || data.startsWith("mentor-") ||
        data.startsWith("fso_") ||
        data.startsWith("tas_") || data.startsWith("task_") || data.startsWith("tbk_") || data.startsWith("b_") || data.startsWith("ticket_") ||
        data.startsWith("broadcast_") || data.startsWith("pref_") || data.startsWith("onb_") ||
        data.startsWith("gender_") || data.startsWith("city_") || data.startsWith("loc_") || data.startsWith("src_") ||
        data.startsWith("close_topic_") || data.startsWith("close_ticket_") || data.startsWith("contact_hr") || data.startsWith("contact_recovery") || data.startsWith("recovery_reopen_") ||
        data.startsWith("end_support_chat") || data.startsWith("view_staff_") ||
        data.startsWith("view_candidate_") || data.startsWith("approve_") || data.startsWith("reject_") ||
        data.startsWith("parcel_") ||
        data.startsWith("confirm_") || data.startsWith("cancel_") || data.startsWith("staging_") ||
        data.includes("/");
}

export function shouldShieldStaleCallback(data: string, chatType: string | undefined): boolean {
    return chatType === "private" && !isKnownCallback(data);
}
