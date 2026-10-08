import { Composer } from "grammy";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { SUPPORT_THREADS_ENABLED, TEAM_CHATS } from "../config.js";
import { getAdminRoleByTelegramId, hasPermission } from "../config/roles.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { supportEscalationService, supportRelayService } from "../services/support-thread-runtime.js";

/**
 * Обробники постійних тем підтримки (spec 2026-10-08): кнопки картки
 * (покликати / повернути), правки і реакції в обидва боки. Повідомлення —
 * у handlers/index.ts (група) і modules/staff (приватний чат).
 */

const CALL_PATTERN = /^sth:c:([^:]+):(k|h)$/;
const BACK_PATTERN = /^sth:b:([^:]+)$/;

function isSupportTeam(telegramId: number | undefined): boolean {
    return telegramId !== undefined && hasPermission(getAdminRoleByTelegramId(BigInt(telegramId)), "SUPPORT_CHAT");
}

export async function supportThreadCallback(ctx: MyContext): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const from = ctx.from;
    if (!from || !isSupportTeam(from.id)) {
        await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["support-thread-ans-team-only"], show_alert: true }).catch(() => undefined);
        return;
    }
    const actor = { id: from.id, firstName: from.first_name };

    const called = CALL_PATTERN.exec(data);
    if (called) {
        try {
            await supportEscalationService.call(ctx.api, called[1]!, called[2] === "k" ? "kuznetsov" : "hupalova", actor);
            await ctx.answerCallbackQuery(ADMIN_TEXTS["support-thread-ans-called"]).catch(() => undefined);
        } catch (error) {
            const notConfigured = /not configured/i.test(String((error as Error)?.message));
            logger.warn({ err: error, data }, "Support escalation failed");
            await ctx.answerCallbackQuery({
                text: notConfigured ? ADMIN_TEXTS["support-thread-ans-not-configured"] : ADMIN_TEXTS["support-thread-ans-failed"],
                show_alert: true,
            }).catch(() => undefined);
        }
        return;
    }

    const back = BACK_PATTERN.exec(data);
    if (back) {
        try {
            const changed = await supportEscalationService.backToSupport(ctx.api, back[1]!, actor);
            await ctx.answerCallbackQuery(changed ? ADMIN_TEXTS["support-thread-ans-back"] : ADMIN_TEXTS["support-thread-ans-not-escalated"]).catch(() => undefined);
        } catch (error) {
            logger.warn({ err: error, data }, "Support back-to-support failed");
            await ctx.answerCallbackQuery({ text: ADMIN_TEXTS["support-thread-ans-failed"], show_alert: true }).catch(() => undefined);
        }
    }
}

function sideOf(chat: { id: number; type: string } | undefined): "staff" | "support" | null {
    if (!chat) return null;
    if (chat.type === "private") return "staff";
    if (chat.id === Number(TEAM_CHATS.SUPPORT)) return "support";
    return null;
}

export async function supportThreadEdit(ctx: MyContext): Promise<void> {
    const message = ctx.editedMessage;
    const side = sideOf(message?.chat);
    if (!message || !side) return;
    await supportRelayService.relayEdit(ctx.api, message, side).catch(error => logger.warn({ err: error }, "Support edit relay failed"));
}

export async function supportThreadReaction(ctx: MyContext): Promise<void> {
    const update = ctx.messageReaction;
    const side = sideOf(update?.chat);
    if (!update || !side) return;
    await supportRelayService.relayReaction(ctx.api, update, side).catch(error => logger.warn({ err: error }, "Support reaction relay failed"));
}

export const supportThreadHandlers = new Composer<MyContext>();

if (SUPPORT_THREADS_ENABLED) {
    supportThreadHandlers.callbackQuery([CALL_PATTERN, BACK_PATTERN], supportThreadCallback);
    supportThreadHandlers.on("edited_message", supportThreadEdit);
    supportThreadHandlers.on("message_reaction", supportThreadReaction);
}
