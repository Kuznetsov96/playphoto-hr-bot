import type { Api } from "grammy";
import { TEAM_CHATS } from "../../../config.js";
import { STAFF_TEXTS } from "../../../constants/staff-texts.js";
import { escapeHtml } from "../../../handlers/admin/utils.js";
import { ActionDedupeWindow } from "../../../utils/action-dedupe.js";

/** Скільки рядок чекає першого повідомлення фотографа. Далі — стара історія, не цей тікет. */
export const SHOOT_SUPPORT_LINE_TTL_MS = 30 * 60_000;

/** Подвійне натискання кнопки нагадування не повинно двічі писати рядок у відкриту тему. */
export const SHOOT_LINE_TOPIC_DEDUPE_MS = 10_000;

export type PendingShootSupportLine = { line: string; at: number };

type ShootLineSession = { shootSupportLine?: unknown };

/**
 * Рядок про зйомку з кнопки «Написати в підтримку» нагадування (план 4). Живе в сесії
 * від натискання до першого повідомлення фотографа, але не довше 30 хвилин — так само,
 * як clarificationTaskId, плюс строк. Телефону клієнта в рядку немає (вебапп його не
 * віддає), а в логи він іде лише через санітайзер ChatLog — тут рядок не логується.
 */
export function putShootSupportLine(session: ShootLineSession, line: string, at: number = Date.now()): void {
    session.shootSupportLine = { line, at } satisfies PendingShootSupportLine;
}

export function clearShootSupportLine(session: ShootLineSession): void {
    delete session.shootSupportLine;
}

/**
 * Читає і стирає. Прострочений рядок і значення старого формату (рядок без часу,
 * з сесій до строку) вважаються простроченими й відкидаються.
 */
export function takeShootSupportLine(session: ShootLineSession, now: number = Date.now()): PendingShootSupportLine | null {
    const value = session.shootSupportLine;
    delete session.shootSupportLine;
    if (typeof value !== "object" || value === null) return null;
    const { line, at } = value as Partial<PendingShootSupportLine>;
    if (typeof line !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
    if (now - at > SHOOT_SUPPORT_LINE_TTL_MS) return null;
    const trimmed = line.trim();
    return trimmed === "" ? null : { line: trimmed, at };
}

const topicDedupe = new ActionDedupeWindow(SHOOT_LINE_TOPIC_DEDUPE_MS);

/** Перше натискання за 10 секунд бере право надіслати рядок у тему; друге — ні. */
export function acquireShootLineTopicSend(userId: string, topicId: number, line: string): string | null {
    const key = `${userId}:${topicId}:${line}`;
    return topicDedupe.tryAcquire(key) ? key : null;
}

/** Відправка не вдалася — наступне натискання має право спробувати знову. */
export function releaseShootLineTopicSend(key: string): void {
    topicDedupe.release(key);
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
