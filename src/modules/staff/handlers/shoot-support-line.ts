import type { Api } from "grammy";
import { TEAM_CHATS } from "../../../config.js";
import { STAFF_TEXTS } from "../../../constants/staff-texts.js";
import { escapeHtml } from "../../../handlers/admin/utils.js";

/**
 * Рядок про зйомку з кнопки «Написати в підтримку» нагадування (план 4). Живе в сесії
 * рівно від натискання до першого повідомлення фотографа — так само, як clarificationTaskId.
 * Телефону клієнта в рядку немає (вебапп його не віддає), а в логи він іде лише через
 * санітайзер ChatLog — тут рядок не логується.
 */
export function takeShootSupportLine(session: { shootSupportLine?: string }): string | null {
    const line = session.shootSupportLine?.trim() ?? "";
    delete session.shootSupportLine;
    return line === "" ? null : line;
}

export function withShootSupportPrefix(question: string, line: string): string {
    return `${STAFF_TEXTS["shoot-task-support-prefix"]({ line: escapeHtml(line) })}\n\n<b>Питання:</b> ${question}`;
}

/** Діалог уже відкрито: рядок іде окремим повідомленням у ту ж тему — і не губиться. */
export async function forwardShootLineToTopic(
    api: Pick<Api, "sendMessage">,
    topicId: number | null,
    line: string,
    chatId: number = TEAM_CHATS.SUPPORT,
): Promise<boolean> {
    if (topicId === null) return false;
    await api.sendMessage(chatId, STAFF_TEXTS["shoot-task-support-open-topic"]({ line: escapeHtml(line) }), {
        message_thread_id: topicId,
        parse_mode: "HTML",
    });
    return true;
}
