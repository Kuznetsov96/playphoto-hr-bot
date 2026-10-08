import type { MyContext } from "../../../types/context.js";
import logger from "../../../core/logger.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { taskService } from "../../../services/task-service.js";
import { taskProofService } from "../../../services/task-proof-service.js";
import { supportRelayService } from "../../../services/support-thread-runtime.js";
import type { ThreadContext } from "../../../services/support-relay-service.js";
import { takeShootSupportLine } from "./shoot-support-line.js";
import { isRelayable } from "../../../utils/support-thread-format.js";
import { STAFF_TEXTS } from "../../../constants/staff-texts.js";

/**
 * Повідомлення співробітниці в приватному чаті, яке не забрав жоден сценарій,
 * іде в її постійну тему підтримки (spec 2026-10-08). Контекст — задача,
 * зйомка, розсилка, фінансове питання — бот кладе в тему перед повідомленням.
 */

const TASK_REPLY_STEP_PREFIX = "awaiting_task_proof_topic_reply_";

/** Вміст від людини, який Telegram не дасть скопіювати (на відміну від службових подій). */
const UNSUPPORTED_CONTENT_KEYS = ["story", "game", "invoice", "paid_media", "giveaway", "giveaway_winners", "users_shared", "chat_shared", "web_app_data", "passport_data"];

function isUnsupportedContent(message: object): boolean {
    const record = message as Record<string, unknown>;
    return UNSUPPORTED_CONTENT_KEYS.some(key => record[key] !== undefined);
}
const FINANCE_AUDIT_MARKER = "Потрібне уточнення по фінансах";
const PREVIEW_LIMIT = 250;

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plain(html: string): string {
    return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function taskContext(taskId: string): Promise<ThreadContext | null> {
    const task = await taskService.getTaskById(taskId);
    if (!task) return null;
    const day = task.workDate
        ? task.workDate.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })
        : null;
    const where = task.locationName || task.city || null;
    const preview = truncate(plain(task.taskText), PREVIEW_LIMIT);
    const head = ["❓ <b>Task question</b>", day, where ? escapeHtml(where) : null].filter(Boolean).join(" · ");
    return {
        topicHtml: `${head}\n<i>${escapeHtml(preview)}</i>`,
        contextText: `Завдання${day ? ` ${day}` : ""}: ${preview}`,
    };
}

async function collectContexts(ctx: MyContext): Promise<ThreadContext[]> {
    const contexts: ThreadContext[] = [];
    const session = ctx.session;

    // Задача — лише одразу після «❓ Питання по завданню» (крок create_ticket). Скасоване
    // уточнення не має приліпитися до питання про зарплату через три дні.
    let taskId = session.step === "create_ticket" ? session.clarificationTaskId ?? null : null;
    delete session.clarificationTaskId;
    if (session.step?.startsWith(TASK_REPLY_STEP_PREFIX)) {
        const submission = await taskProofService.getSubmissionById(session.step.slice(TASK_REPLY_STEP_PREFIX.length));
        taskId = taskId ?? submission?.taskId ?? null;
        if (session.taskProofFlow) delete session.taskProofFlow.replySubmissionId;
    }
    if (taskId) {
        const context = await taskContext(taskId);
        if (context) contexts.push(context);
    }

    const shootLine = takeShootSupportLine(session);
    if (shootLine) {
        contexts.push({ topicHtml: `📸 <b>Shoot question</b>\n${escapeHtml(shootLine.line)}`, contextText: shootLine.line });
    }

    if (session.step === "broadcast_decline_reason" && session.broadcastId) {
        contexts.push({ topicHtml: `📣 <b>Disagrees with broadcast #${session.broadcastId}</b>`, contextText: `Розсилка #${session.broadcastId}` });
    }
    delete session.broadcastId;

    const replied = ctx.message?.reply_to_message;
    const repliedText = replied?.text ?? replied?.caption;
    if (repliedText?.includes(FINANCE_AUDIT_MARKER)) {
        const source = truncate(repliedText, PREVIEW_LIMIT);
        contexts.push({ topicHtml: `💰 <b>Finance audit reply</b>\n<i>${escapeHtml(source)}</i>`, contextText: source });
    }

    // Частина альбому: наступні частини мають іти в підтримку, а не в чернетку звіту.
    session.step = ctx.message?.media_group_id ? "create_ticket" : "idle";
    return contexts;
}

export async function handleStaffThreadMessage(ctx: MyContext): Promise<boolean> {
    const message = ctx.message;
    if (ctx.chat?.type !== "private" || !message || !ctx.from) return false;
    if (message.text?.startsWith("/")) return false;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(ctx.from.id));
    if (!user?.staffProfile) return false;

    // Історія, розіграш, гра — Telegram не дасть скопіювати: сказати їй і не витрачати
    // контекст. Службові події (закріп, фон, таймер) — мовчки, це не повідомлення.
    if (!isRelayable(message)) {
        if (isUnsupportedContent(message)) await ctx.reply(STAFF_TEXTS["support-thread-unsupported"]).catch(() => undefined);
        return true;
    }

    let contexts: ThreadContext[] = [];
    try {
        contexts = await collectContexts(ctx);
    } catch (error) {
        // Контекст — підказка для команди; без нього повідомлення все одно має дійти.
        logger.warn({ err: error, userId: user.id }, "Support thread context could not be built");
    }

    await supportRelayService.relayStaffMessage(ctx.api, { userId: user.id, chatId: ctx.chat.id, message, contexts });
    return true;
}
