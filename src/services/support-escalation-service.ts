import type { Api } from "grammy";
import logger from "../core/logger.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import type { SupportThreadRepository } from "../repositories/support-thread-repository.js";
import type { SupportThreadService } from "./support-thread-service.js";
import { ActionDedupeWindow } from "../utils/action-dedupe.js";

/**
 * «Покликати» Кузнєцова чи Гупалову в тему і повернути її Support-акаунту
 * (spec 2026-10-08). Тема лишається за менеджеркою: вона пише далі сама,
 * ескалація — лише позначка і сповіщення.
 */

export type EscalationTarget = "kuznetsov" | "hupalova";

export type EscalationDeps = {
    threads: Pick<SupportThreadService, "applyStatus">;
    repo: Pick<SupportThreadRepository, "findById" | "listIncomingSince">;
    targets: () => { kuznetsov: number | undefined; hupalova: number | undefined; support: number | undefined };
    topicLink: (chatId: bigint, topicId: number) => string;
};

const LABELS: Record<EscalationTarget | "support", string> = { kuznetsov: "Kuznetsov", hupalova: "Hupalova", support: "Support" };

/** Скільки останніх повідомлень фотографині без відповіді показати покликаному. */
const CONTEXT_MESSAGES = 3;

const mention = (telegramId: number, label: string) => `<a href="tg://user?id=${telegramId}">${label}</a>`;

export const backButton = (threadId: string) => ({
    inline_keyboard: [[{ text: ADMIN_TEXTS["support-thread-btn-back"], callback_data: `sth:b:${threadId}` }]],
});

/** Подвійне натискання «🔔» не має кликати двічі. */
const CALL_DEDUPE_MS = 15_000;

export class SupportEscalationService {
    private readonly callDedupe = new ActionDedupeWindow(CALL_DEDUPE_MS);

    constructor(private readonly deps: EscalationDeps) {}

    async call(api: Api, threadId: string, target: EscalationTarget, caller: { id: number; firstName: string }): Promise<void> {
        const targetId = this.deps.targets()[target];
        if (!targetId) throw new Error(`Escalation target ${target} is not configured`);
        const dedupeKey = `${threadId}:${target}`;
        if (!this.callDedupe.tryAcquire(dedupeKey)) return;
        try {
            await this.callOnce(api, threadId, target, targetId, caller);
        } catch (error) {
            this.callDedupe.release(dedupeKey); // невдале натискання не блокує наступне
            throw error;
        }
    }

    private async callOnce(api: Api, threadId: string, target: EscalationTarget, targetId: number, caller: { id: number; firstName: string }): Promise<void> {
        const thread = await this.deps.repo.findById(threadId);
        if (!thread) throw new Error(`Support thread ${threadId} not found`);

        const escalated = await this.deps.threads.applyStatus(api, thread, { kind: "escalated", targetTelegramId: BigInt(targetId) });
        const callerName = escapeHtml(caller.firstName);

        await api.sendMessage(
            Number(escalated.chatId),
            ADMIN_TEXTS["support-thread-called"]({ mention: mention(targetId, LABELS[target]), caller: callerName }),
            { message_thread_id: escalated.topicId, parse_mode: "HTML", reply_markup: backButton(threadId) },
        );

        try {
            await api.sendMessage(targetId, ADMIN_TEXTS["support-thread-called-dm"]({ caller: callerName, title: escapeHtml(escalated.title) }), {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: ADMIN_TEXTS["support-thread-btn-open"], url: this.deps.topicLink(escalated.chatId, escalated.topicId) }],
                        [{ text: ADMIN_TEXTS["support-thread-btn-back"], callback_data: `sth:b:${threadId}` }],
                    ],
                },
            });
            const unanswered = await this.deps.repo.listIncomingSince(threadId, thread.lastSupportAt, CONTEXT_MESSAGES);
            for (const link of [...unanswered].reverse()) {
                await api.copyMessage(targetId, Number(escalated.chatId), link.topicMessageId).catch(error => {
                    logger.debug({ err: error, threadId }, "Escalation context message could not be copied");
                });
            }
        } catch (error) {
            // Згадка в темі вже сповістила; приватне — запасний канал.
            logger.warn({ err: error, threadId, target }, "Escalation DM could not be delivered");
        }
    }

    /** false — тема й так у Support, нічого не змінено. */
    async backToSupport(api: Api, threadId: string, actor: { id: number; firstName: string }): Promise<boolean> {
        const thread = await this.deps.repo.findById(threadId);
        if (!thread || thread.status !== "ESCALATED") return false;

        const hasUnansweredQuestion = Boolean(
            thread.lastQuestionAt && (!thread.lastSupportAt || thread.lastQuestionAt.getTime() > thread.lastSupportAt.getTime()),
        );
        const updated = await this.deps.threads.applyStatus(api, thread, { kind: "back_to_support", hasUnansweredQuestion });
        // Повернули — нове покликання має спрацювати одразу, а не через 15 с.
        this.callDedupe.release(`${threadId}:kuznetsov`);
        this.callDedupe.release(`${threadId}:hupalova`);
        const supportId = this.deps.targets().support;
        const supportMention = supportId ? mention(supportId, LABELS.support) : LABELS.support;
        await api.sendMessage(
            Number(updated.chatId),
            ADMIN_TEXTS["support-thread-back"]({ mention: supportMention, actor: escapeHtml(actor.firstName) }),
            { message_thread_id: updated.topicId, parse_mode: "HTML" },
        );
        return true;
    }
}
