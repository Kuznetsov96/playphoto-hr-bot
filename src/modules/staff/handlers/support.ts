import { STAFF_TEXTS } from "../../../constants/staff-texts.js";

import logger from "../../../core/logger.js";
import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import { RECOVERY_CHAT_ID, SUPPORT_CHAT_ID, TEAM_CHATS } from "../../../config.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { supportRepository } from "../../../repositories/support-repository.js";
import { staffRepository } from "../../../repositories/staff-repository.js";
import { candidateRepository } from "../../../repositories/candidate-repository.js";
import { statsService } from "../../../services/stats-service.js";
import prisma from "../../../db/core.js";
import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { TicketStatus } from "@prisma/client";
import { updateTicketVisuals, sendSupportStatus, finalizeTopicUIClosure } from "../../../handlers/support-utils.js";
import { escapeHtml, htmlToPlainText, sendAdminOutboundMessage } from "../../../handlers/admin/utils.js";
import { ScreenManager } from "../../../utils/screen-manager.js";
import { audit } from "../../../core/audit-logger.js";
import { logAuditEvent, logBusinessEvent } from "../../../core/log-events.js";
import { getAdminRoleByTelegramId } from "../../../config/roles.js";
import { ActionDedupeWindow } from "../../../utils/action-dedupe.js";
import { taskProofService } from "../../../services/task-proof-service.js";
import { shortenName } from "../../../utils/string-utils.js";
import { getLocationShortcut } from "../../../utils/ticket-card.js";
import { truncateText } from "../../../utils/task-helpers.js";
import { firstShiftOnboardingService, type FirstShiftOnboardingCandidateMessage } from "../../../services/first-shift-onboarding-service.js";
import { getRichMessagePlainText } from "../../../utils/rich-message.js";

// Statuses that are considered "Active"
const ACTIVE_STATUSES = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS];
const SUPPORT_ACTION_DEBOUNCE_MS = 15_000;
const supportActionDedupe = new ActionDedupeWindow(SUPPORT_ACTION_DEBOUNCE_MS);

export const staffSupportHandlers = new Composer<MyContext>();
const adminSupportCallbacks = new Composer<MyContext>();

function buildOnboardingPayloadFromSupportMessage(ctx: MyContext): FirstShiftOnboardingCandidateMessage {
    const richText = getRichMessagePlainText(ctx.message?.rich_message) || undefined;
    const text = ctx.message?.text || ctx.message?.caption || richText;
    const photoId = ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_id || null;
    const hasMedia = Boolean(
        photoId ||
        ctx.message?.voice ||
        ctx.message?.video_note ||
        ctx.message?.video ||
        ctx.message?.document ||
        ctx.message?.audio ||
        ctx.message?.animation ||
        ctx.message?.sticker ||
        ctx.message?.rich_message,
    );
    const hasFormattedText = Boolean(ctx.message?.entities?.length || ctx.message?.caption_entities?.length);

    const payload: FirstShiftOnboardingCandidateMessage = {
        photoId,
        hasCopyableOriginal: hasMedia || hasFormattedText,
    };
    if (ctx.message?.message_id !== undefined) payload.messageId = ctx.message.message_id;
    if (ctx.chat?.id !== undefined) payload.chatId = ctx.chat.id;
    if (text !== undefined) payload.text = text;
    return payload;
}

adminSupportCallbacks
    .filter((ctx) =>
        ctx.has("callback_query:data") && (
            /^admin_close_ticket_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_assign_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_reply_close_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_urgent_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_close_\d+$/.test(ctx.callbackQuery.data) ||
            /^task_proof_close_[a-zA-Z0-9]+$/.test(ctx.callbackQuery.data) ||
            /^close_topic_\d+$/.test(ctx.callbackQuery.data) ||
            /^recovery_reopen_[a-zA-Z0-9_\-]+_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_force_close_\d+$/.test(ctx.callbackQuery.data) ||
            /^onboard_pass_[a-zA-Z0-9_\-]+_\d+$/.test(ctx.callbackQuery.data) ||
            /^onboard_fail_[a-zA-Z0-9_\-]+_\d+$/.test(ctx.callbackQuery.data) ||
            /^ticket_transfer_\d+_\d+$/.test(ctx.callbackQuery.data)
        )
    )
    .use(async (ctx, next) => {
        const telegramId = ctx.from?.id;
        if (!telegramId || !getAdminRoleByTelegramId(BigInt(telegramId))) {
            await ctx.answerCallbackQuery({ text: "Недостатньо прав для цієї дії", show_alert: true }).catch(() => { });
            return;
        }

        await next();
    });

staffSupportHandlers.use(adminSupportCallbacks);

function isDuplicateSupportAction(actionKey: string) {
    return !supportActionDedupe.tryAcquire(actionKey);
}

function getSupportMessageTypeLabel(message: NonNullable<MyContext["message"]>): string {
    if (message.text) return "текст";
    if (message.rich_message) return "rich message";
    if (message.photo) return "фото";
    if (message.video) return "відео";
    if (message.document) return "документ";
    if (message.sticker) return "стікер";
    if (message.voice) return "голосове повідомлення";
    if (message.video_note) return "відеокружечок";
    if (message.contact) return "контакт";
    if (message.location) return "локація";
    if (message.animation) return "анімація";
    if (message.audio) return "аудіо";
    if (message.poll) return "опитування";
    if (message.dice) return "dice";
    if (message.venue) return "venue";
    return "непідтримуваний тип повідомлення";
}

function getSupportMessagePreview(message: NonNullable<MyContext["message"]>): string {
    const text = message.text || message.caption || getRichMessagePlainText(message.rich_message);
    if (text) return text;
    return `[${getSupportMessageTypeLabel(message)}]`;
}

function buildSupportFallbackBody(message: NonNullable<MyContext["message"]>): string {
    const text = message.text || message.caption || getRichMessagePlainText(message.rich_message);
    if (text) {
        return `📝 <b>Вміст повідомлення</b>\n${escapeHtml(text)}`;
    }

    return `⚠️ <b>Повідомлення не вдалося автоматично переслати</b>\nТип: <b>${escapeHtml(getSupportMessageTypeLabel(message))}</b>`;
}

function classifySupportForwardingError(error: any) {
    const rawMessage = error?.description || error?.message || "Unknown Telegram API error";
    const normalizedMessage = String(rawMessage).toLowerCase();
    const isTopicError = normalizedMessage.includes("thread") ||
        normalizedMessage.includes("topic") ||
        normalizedMessage.includes("not found");
    const isNotForwardable = normalizedMessage.includes("can't be forwarded") ||
        normalizedMessage.includes("message can't be forwarded");

    return {
        rawMessage: String(rawMessage),
        isTopicError,
        isNotForwardable,
    };
}

function buildTaskProofTopicBaseTitle(submission: Awaited<ReturnType<typeof taskProofService.getSubmission>>) {
    if (!submission) return "Task Proof";

    const task = submission.task;
    const staffName = shortenName(submission.staff.fullName);
    const locationName = task.locationName || submission.staff.location?.name || null;
    const locationCity = task.city || submission.staff.location?.city || null;
    const locationCode = locationName ? getLocationShortcut(locationName, locationCity) : "Task";
    const topicDate = task.workDate
        ? task.workDate.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", timeZone: "Europe/Kyiv" })
        : "??.??";

    return `📎 ${locationCode} | ${staffName} | ${topicDate}`;
}

// 1. Start Ticket Creation Flow
staffSupportHandlers.callbackQuery("staff_help", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const activeOnboardingCase = await firstShiftOnboardingService.findActiveCaseByTelegramId(telegramId);
    if (activeOnboardingCase) {
        await ctx.answerCallbackQuery("Під час онбордінгу питання йдуть у спеціальний topic.").catch(() => { });
        await ScreenManager.renderScreen(
            ctx,
            "🚀 <b>Онбордінг першої зміни ще відкритий.</b>\n\nПросто напиши повідомлення сюди, і я передам його в onboarding-topic ментора.",
            new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"),
            { forceNew: true }
        );
        return;
    }

    // Check if user has active ticket
    const user = await userRepository.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    // Shield: Prevent deactivated staff from using support
    const staff = await staffRepository.findByUserId(user.id);
    if (staff && !staff.isActive) {
        await ctx.answerCallbackQuery({ text: "Access Revoked", show_alert: true });
        return;
    }

    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);

    if (activeTicket) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-processing"]);
        await ScreenManager.renderScreen(ctx, STAFF_TEXTS["support-info-already-open"], new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"));
        return;
    }

    const activeOutgoingTopic = await supportRepository.findActiveOutgoingTopicByUser(user.id);
    if (activeOutgoingTopic) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-processing"]);
        await ScreenManager.renderScreen(ctx, "💬 <b>Обговорення відкрито:</b>\nАдміністратор створив діалог з тобою. Просто напиши своє повідомлення сюди, і я його передам.", new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"));
        return;
    }

    ctx.session.step = "create_ticket";
    audit({ event: "ticket_create", result: "started", actorType: "staff", telegramId, entityType: "ticket", updateId: ctx.update.update_id });
    logAuditEvent({
        event: "support.ticket.creation_started",
        telegramId,
        actorType: "staff",
        actorRole: "staff",
        result: "started",
        module: "staff-support-handler",
        operation: "staff_help",
        updateId: ctx.update.update_id,
        userId: user.id,
    });
    await ctx.answerCallbackQuery();
    const text = STAFF_TEXTS["support-ask-issue"];

    const kb = new InlineKeyboard();

    // Add Logistics button for Support role
    const { getUserAdminRole } = await import("../../../middleware/role-check.js");
    const role = await getUserAdminRole(BigInt(telegramId));
    if (role === 'SUPPORT' || role === 'SUPER_ADMIN' || role === 'CO_FOUNDER') {
        kb.text("📦 Logistics", "admin_logistics_nav").row();
    }

    kb.text(STAFF_TEXTS["hr-btn-cancel"], "staff_hub_nav").danger();

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
});

// 2. Close Ticket by User
staffSupportHandlers.callbackQuery(/^close_ticket_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    await closeTicket(ctx, ticketId, "USER");
});

// 3. Close Ticket by Admin
staffSupportHandlers.callbackQuery(/^admin_close_ticket_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    await closeTicket(ctx, ticketId, "ADMIN");
});

// 4. Assign Ticket (Take to Work)
staffSupportHandlers.callbackQuery(/^ticket_assign_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    const adminId = ctx.from?.id;
    if (!adminId) return;

    try {
        const { supportService } = await import("../../../services/support-service.js"); // Lazy import or use DI container
        const ticket = await supportService.assignTicket(ticketId, adminId);

        audit({ event: "ticket_assign", result: "success", actorType: "admin", telegramId: adminId, entityType: "ticket", entityId: ticketId, updateId: ctx.update.update_id });
        logAuditEvent({
            event: "support.ticket.assigned_from_support_ui",
            telegramId: adminId,
            actorType: "admin",
            actorRole: "admin",
            result: "success",
            module: "staff-support-handler",
            operation: "ticket_assign",
            updateId: ctx.update.update_id,
            safeContext: {
                ticketId,
                targetUserId: ticket.userId,
            },
        });

        // Visual Updates (Topic Title, Card)
        await updateTicketVisuals(ctx, ticketId);

        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-assigned"]({ ticketId: ticketId.toString() }));

        // Notify user
        await ctx.api.sendMessage(Number(ticket.user.telegramId), STAFF_TEXTS["support-info-assigned-to-user"], { parse_mode: "HTML" }).catch(() => { });
    } catch (e: any) {
        await ctx.answerCallbackQuery({ text: e.message || "Error", show_alert: true });
    }
});

// 5. Reply & Close Ticket
staffSupportHandlers.callbackQuery(/^ticket_reply_close_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    const ticket = await supportRepository.findTicketById(ticketId);

    if (!ticket || ticket.status === TicketStatus.CLOSED) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-closed"]);
        return;
    }

    // Set session to wait for reply
    ctx.session.step = "reply_and_close";
    ctx.session.ticketId = ticketId;

    await ctx.answerCallbackQuery();
    await ctx.reply(STAFF_TEXTS["support-ask-reply"], {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(STAFF_TEXTS["hr-btn-cancel"], "cancel_step").danger()
    });
});

// 6. Toggle Urgent Flag
staffSupportHandlers.callbackQuery(/^ticket_urgent_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    if (isDuplicateSupportAction(`ticket-urgent:${ctx.from?.id}:${ticketId}`)) {
        await ctx.answerCallbackQuery("Зачекай, прапорець терміновості вже оновлюється.");
        return;
    }

    try {
        const { supportService } = await import("../../../services/support-service.js");
        const { newUrgent } = await supportService.toggleUrgent(ticketId, ctx.from?.id);

        audit({ event: "ticket_urgent_toggle", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "ticket", entityId: ticketId, updateId: ctx.update.update_id, context: { isUrgent: newUrgent } });
        logAuditEvent({
            event: "support.ticket.urgent_toggled_from_support_ui",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: "admin",
            result: "success",
            module: "staff-support-handler",
            operation: "ticket_urgent",
            updateId: ctx.update.update_id,
            safeContext: {
                ticketId,
                isUrgent: newUrgent,
            },
        });

        // Visual Updates
        await updateTicketVisuals(ctx, ticketId);

        const statusText = newUrgent ? STAFF_TEXTS["support-status-urgent"] : STAFF_TEXTS["support-status-normal"];
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-urgent-status"]({ ticketId: ticketId.toString(), status: statusText }));
    } catch (e: any) {
        await ctx.answerCallbackQuery({ text: e.message || "Error", show_alert: true });
    }
});

// 6. Close Ticket (Admin)
staffSupportHandlers.callbackQuery(/^ticket_close_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    await closeTicket(ctx, ticketId, "ADMIN");
});

staffSupportHandlers.callbackQuery(/^task_proof_close_([a-zA-Z0-9]+)$/, async (ctx) => {
    const submissionId = ctx.match[1]!;
    const submission = await taskProofService.getSubmissionById(submissionId);
    if (!submission || !submission.supportTopicId || !submission.supportChatId) {
        await ctx.answerCallbackQuery("Уточнення вже закрито або topic не знайдено.");
        return;
    }

    await taskProofService.closeSupportTopic(submission.id);

    const baseTitle = buildTaskProofTopicBaseTitle(submission);
    await finalizeTopicUIClosure(ctx, String(submission.supportChatId), submission.supportTopicId, baseTitle);

    const targetTelegramId = Number(submission.staff.user.telegramId);
    const keyboard = new InlineKeyboard().text(STAFF_TEXTS["staff-btn-home"], "staff_hub_nav");
    await sendSupportStatus(
        ctx,
        `✅ <b>Уточнення по завданню закрито.</b>\n\nЯкщо буде потрібно, ми напишемо ще раз окремо.`,
        { parse_mode: "HTML", reply_markup: keyboard },
        targetTelegramId
    );

    logBusinessEvent({
        event: "task_proof.topic.closed",
        actorType: "admin",
        actorRole: "admin",
        telegramId: ctx.from?.id,
        result: "success",
        module: "staff-support-handler",
        operation: "task_proof_close",
        updateId: ctx.update.update_id,
        safeContext: {
            submissionId,
            topicId: submission.supportTopicId,
            chatId: String(submission.supportChatId),
            taskId: submission.taskId,
        },
    });
});

// 7. Close Outgoing Topic (Admin)
staffSupportHandlers.callbackQuery(/^close_topic_(\d+)$/, async (ctx) => {
    const topicId = Number(ctx.match[1]);

    try {
        const outgoingTopic = await supportRepository.findOutgoingTopicByTopicId(topicId);

        if (!outgoingTopic || outgoingTopic.isClosed) {
            return await ctx.answerCallbackQuery("Topic is already closed! ✅");
        }

        // Mark as closed in DB
        await prisma.outgoingTopic.update({
            where: { id: outgoingTopic.id },
            data: { isClosed: true }
        });

        // Determine nice title for Outgoing Topic closure
        let newTitle = "Closed Outgoing Topic";
        if (outgoingTopic.userId) {
            const user = await userRepository.findWithStaffProfileById(outgoingTopic.userId);
            if (user) {
                const staffName = user.staffProfile?.fullName || outgoingTopic.staffName || "Unknown";
                const surname = staffName.split(' ')[0] || staffName;
                const loc = user.staffProfile?.location || (await candidateRepository.findByUserId(user.id))?.location;
                const locPart = loc ? ` | ${loc.name}` : "";
                newTitle = `✖️ ${surname}${locPart}`;
            }
        }

        // Unified UI Closure
        await finalizeTopicUIClosure(ctx, String(outgoingTopic.chatId), topicId, newTitle);
        logBusinessEvent({
            event: "support.outgoing_topic.closed",
            actorType: "admin",
            actorRole: "admin",
            telegramId: ctx.from?.id,
            result: "success",
            module: "staff-support-handler",
            operation: "close_topic",
            updateId: ctx.update.update_id,
            safeContext: {
                topicId,
                outgoingTopicId: outgoingTopic.id,
                userId: outgoingTopic.userId,
            },
        });

    } catch (e: any) {
        logger.error({ err: e, topicId }, "Support outgoing topic close failed");
        await ctx.answerCallbackQuery(`❌ Error: ${e.message}`);
    }
});

staffSupportHandlers.callbackQuery(/^recovery_reopen_([a-zA-Z0-9_\-]+)_(\d+)$/, async (ctx) => {
    const candidateId = ctx.match[1]!;
    const topicId = Number(ctx.match[2]);

    try {
        const candidate = await candidateRepository.reopenRecoveryCandidate(candidateId);

        await ctx.api.sendMessage(Number(candidate.user.telegramId),
            "✅ <b>Анкету повернуто в чергу HR.</b>\n\nМи знову розглядаємо твій профіль. Коли буде наступний крок, напишемо тобі тут.",
            { parse_mode: "HTML" }
        ).catch(() => { });

        await ctx.reply(
            `✅ Candidate moved to <b>WAITLIST_HR</b>.`,
            { parse_mode: "HTML", message_thread_id: topicId }
        );

        if (ctx.callbackQuery.message) {
            await ctx.editMessageReplyMarkup({
                reply_markup: new InlineKeyboard().text("Close Recovery", `close_topic_${topicId}`)
            }).catch(() => { });
        }

        await ctx.answerCallbackQuery("Candidate reopened to WAITLIST_HR");
    } catch (e: any) {
        await ctx.answerCallbackQuery({
            text: e.message === "CANDIDATE_NOT_RECOVERY_ELIGIBLE"
                ? "This candidate cannot be reopened from recovery"
                : `Error: ${e.message}`,
            show_alert: true,
        }).catch(() => { });
    }
});

// 8. Force Close Ticket (Technical/Silent)
staffSupportHandlers.callbackQuery(/^ticket_force_close_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);
    const { supportService } = await import("../../../services/support-service.js");
    const ticket = await supportService.getTicket(ticketId);

    if (!ticket || ticket.status === TicketStatus.CLOSED) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-closed"]);
        return;
    }

    // Close in DB
    const closedTicket = await supportService.closeTicket(ticketId);
    if (!closedTicket) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-closed"]);
        return;
    }

    // Try to close topic silently
    if (ticket.topicId) {
        try {
            await ctx.api.closeForumTopic(SUPPORT_CHAT_ID, ticket.topicId);
        } catch (e) {
            logger.warn({ err: e, ticketId }, "Support topic close failed during force-close flow");
        }
    }

    await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-force-closed"]);
    await ctx.editMessageText(STAFF_TEXTS["support-info-force-closed"]({ ticketId: ticketId.toString() }), {
        reply_markup: new InlineKeyboard().text(STAFF_TEXTS["hr-menu-back-home"], "admin_main_back"),
    });
});

// 9. Onboarding Decision: Pass
staffSupportHandlers.callbackQuery(/^onboard_pass_([a-zA-Z0-9_\-]+)_(\d+)$/, async (ctx) => {
    const candId = ctx.match[1]!;
    const ticketId = Number(ctx.match[2]);
    if (isDuplicateSupportAction(`onboard-pass:${candId}:${ticketId}`)) {
        await ctx.answerCallbackQuery("Рішення вже обробляється.");
        return;
    }

    // Auth check: allow if they are in the support group
    const { hrService } = await import("../../../services/hr-service.js");
    const { CANDIDATE_TEXTS } = await import("../../../constants/candidate-texts.js");
    const { extractFirstName } = await import("../../../utils/string-utils.js");

    try {
        const candidate = await candidateRepository.findById(candId);
        if (!candidate || candidate.status !== "STAGING_ACTIVE") {
            await ctx.answerCallbackQuery("Цей онбординг уже оброблено.");
            return;
        }

        const res = await hrService.completeOfflineStaging(candId, true);
        if (res) {
            const firstName = extractFirstName(res.candidate.fullName || "");

            // Send warm welcome per user request
            await ctx.api.sendMessage(
                Number(res.candidate.user.telegramId),
                `🌸 <b>${firstName}</b>, вітаємо з успішним проходженням першої зміни!\n\nТи чудово впоралась! 🎉 Бажаємо плідного шляху та багато крутих кадрів разом з PlayPhoto! ✨`,
                { parse_mode: "HTML" }
            );

            await ctx.answerCallbackQuery("Кандидат успішно пройшов стажування! ✅");
            logAuditEvent({
                event: "admin.candidate.offline_staging_marked_passed_from_support",
                telegramId: ctx.from?.id,
                actorType: "admin",
                actorRole: "admin",
                candidateId: res.candidate.id,
                result: "success",
                stage: "STAGING_ACTIVE",
                module: "staff-support-handler",
                operation: "onboard_pass",
                updateId: ctx.update.update_id,
                safeContext: { ticketId },
            });

            // Close the onboarding topic
            await closeTicket(ctx, ticketId, "ADMIN");
        }
    } catch (e: any) {
        await ctx.answerCallbackQuery(`Помилка: ${e.message}`);
    }
});

// 10. Onboarding Decision: Fail
staffSupportHandlers.callbackQuery(/^onboard_fail_([a-zA-Z0-9_\-]+)_(\d+)$/, async (ctx) => {
    const candId = ctx.match[1]!;
    const ticketId = Number(ctx.match[2]);
    if (isDuplicateSupportAction(`onboard-fail:${candId}:${ticketId}`)) {
        await ctx.answerCallbackQuery("Рішення вже обробляється.");
        return;
    }

    const { hrService } = await import("../../../services/hr-service.js");
    const { candidateRepository } = await import("../../../repositories/candidate-repository.js");
    const { extractFirstName } = await import("../../../utils/string-utils.js");

    try {
        const cand = await candidateRepository.findById(candId);
        if (!cand || cand.status !== "STAGING_ACTIVE") {
            await ctx.answerCallbackQuery("Цей онбординг уже оброблено.");
            return;
        }
        await hrService.completeOfflineStaging(candId, false);

        // Send warm comforting message to Failed Candidate per user request
        if (cand && cand.user) {
            const firstName = extractFirstName(cand.fullName || "");
            await ctx.api.sendMessage(
                Number(cand.user.telegramId),
                `🌸 <b>${firstName}</b>, дякуємо за проведений час на зміні.\n\nНа жаль, на цьому етапі ми не можемо запропонувати співпрацю. Але не засмучуйся, це просто досвід! Бажаємо, щоб наступного разу все вийшло найкращим чином. Успіхів тобі! ✨`,
                { parse_mode: "HTML" }
            );
        }

        await ctx.answerCallbackQuery("Кандидат не пройшов. ❌");
        logAuditEvent({
            event: "admin.candidate.offline_staging_marked_failed_from_support",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: "admin",
            candidateId: cand?.id,
            result: "success",
            stage: "STAGING_ACTIVE",
            module: "staff-support-handler",
            operation: "onboard_fail",
            updateId: ctx.update.update_id,
            safeContext: { ticketId },
        });

        // Close the onboarding topic
        await closeTicket(ctx, ticketId, "ADMIN");
    } catch (e: any) {
        await ctx.answerCallbackQuery(`Помилка: ${e.message}`);
    }
});

// 7. Transfer Ticket to Another Admin
// Supports both:
// - New: ticket_transfer_{ticketId}_{adminTgId}
// - Legacy: ticket_transfer_{adminTgId}_{ticketId}
staffSupportHandlers.callbackQuery(/^ticket_transfer_(\d+)_(\d+)$/, async (ctx) => {
    let ticketId = Number(ctx.match[1]);
    let targetAdminTgId = BigInt(ctx.match[2]!);

    // Detect legacy format: if the first number looks like a Telegram ID (large) 
    // and the second looks like a ticket ID (small), swap them.
    if (ticketId > 1000000 && Number(targetAdminTgId) < 1000000) {
        const temp = ticketId;
        ticketId = Number(targetAdminTgId);
        targetAdminTgId = BigInt(temp);
    }

    const initiatorId = ctx.from?.id;
    if (!initiatorId) return;

    try {
        const { supportService } = await import("../../../services/support-service.js");
        const { ticket, targetAdmin } = await supportService.transferTicket(ticketId, targetAdminTgId, initiatorId);

        // Get ticket creator info for DM (kept here as it's UI logic)
        const creator = await userRepository.findWithStaffProfileByTelegramId(BigInt(ticket.user.telegramId));
        if (!creator) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-user-not-found"]);
            return;
        }

        // Format name to Surname + Name
        const fullFullName = creator.staffProfile?.fullName || "Невідомо";
        const formattedName = fullFullName.split(' ').slice(0, 2).join(' ');

        const locationText = creator.staffProfile?.location
            ? (creator.staffProfile.location.city
                ? `${creator.staffProfile.location.name} (${creator.staffProfile.location.city})`
                : creator.staffProfile.location.name)
            : "Unknown";

        // Send DM to target admin with a button
        const urgentFlag = ticket.isUrgent ? "🆘 " : "";
        const dmText = STAFF_TEXTS["support-info-transferred-dm"]({
            urgent: urgentFlag,
            ticketId: ticketId.toString(),
            name: formattedName,
            location: locationText,
            status: "IN PROGRESS"
        });

        const topicUrl = `https://t.me/c/${String(TEAM_CHATS.SUPPORT).replace('-100', '')}/${ticket.topicId}`;
        const keyboard = new InlineKeyboard().url(STAFF_TEXTS["support-btn-go-to-topic"], topicUrl);

        try {
            await ctx.api.sendMessage(Number(targetAdminTgId), dmText, {
                parse_mode: "HTML",
                reply_markup: keyboard
            });
        } catch (e) {
            logger.error({ err: e, targetAdminTelegramId: targetAdminTgId }, "Support direct admin notification failed");
            logBusinessEvent({
                event: "support.ticket.transfer_notification_sent",
                level: "warn",
                actorType: "admin",
                actorRole: "admin",
                telegramId: initiatorId,
                result: "failed",
                reasonCode: "TARGET_ADMIN_DM_FAILED",
                module: "staff-support-handler",
                operation: "ticket_transfer",
                updateId: ctx.update.update_id,
                safeContext: {
                    ticketId,
                    targetAdminTgId: targetAdminTgId.toString(),
                },
                error: e,
            });
        }

        // Refresh ticket card in support chat
        await updateTicketVisuals(ctx, ticketId);
        logAuditEvent({
            event: "support.ticket.transferred_from_support_ui",
            telegramId: initiatorId,
            actorType: "admin",
            actorRole: "admin",
            result: "success",
            module: "staff-support-handler",
            operation: "ticket_transfer",
            updateId: ctx.update.update_id,
            safeContext: {
                ticketId,
                targetAdminTgId: targetAdminTgId.toString(),
                targetAdminId: targetAdmin.id,
            },
        });

        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-transferred"]({ adminName: targetAdmin.firstName || 'admin' }));
    } catch (e: any) {
        await ctx.answerCallbackQuery(e.message || "Error");
    }
});

/**
 * Shared closure logic
 */
async function closeTicket(ctx: MyContext, ticketId: number, initiator: "USER" | "ADMIN", customNotice?: string) {
    const { supportService } = await import("../../../services/support-service.js"); // Lazy import
    const ticket = await supportService.getTicket(ticketId);

    if (!ticket || ticket.status === TicketStatus.CLOSED) {
        if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-closed"]);
        }
        if (ctx.callbackQuery?.message) {
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        }
        return;
    }

    if (initiator === "USER") {
        if (Number(ticket.user.telegramId) !== ctx.from?.id) {
            await ctx.answerCallbackQuery("Ця дія недоступна.");
            return;
        }
    } else {
        const telegramId = ctx.from?.id;
        if (!telegramId || !getAdminRoleByTelegramId(BigInt(telegramId))) {
            await ctx.answerCallbackQuery("Недостатньо прав для цієї дії");
            return;
        }
    }

    // Close in DB via Service
    const closedTicket = await supportService.closeTicket(ticketId);
    if (!closedTicket) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-already-closed"]);
        return;
    }

    audit({ event: "ticket_close", result: "success", actorType: initiator === "ADMIN" ? "admin" : "staff", telegramId: ctx.from?.id, entityType: "ticket", entityId: ticketId, updateId: ctx.update.update_id, context: { closedBy: initiator } });
    logAuditEvent({
        event: "support.ticket.closed",
        telegramId: ctx.from?.id,
        actorType: initiator === "ADMIN" ? "admin" : "staff",
        actorRole: initiator === "ADMIN" ? "admin" : "staff",
        result: "success",
        module: "staff-support-handler",
        operation: "closeTicket",
        updateId: ctx.update.update_id,
        safeContext: {
            ticketId,
            closedBy: initiator,
        },
    });

    // Rename and Close Topic in Support Group
    if (ticket.topicId) {
        try {
            const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(ticket.user.telegramId));
            let closedTitle = `✖️ #${ticketId} | Closed`;
            if (user) {
                const { buildTopicTitle } = await import("../../../utils/ticket-card.js");
                const locationName = user.staffProfile?.location?.name || null;
                const locationCity = user.staffProfile?.location?.city || null;
                closedTitle = buildTopicTitle(ticketId, user.staffProfile?.fullName || "Невідомо", locationName, TicketStatus.CLOSED, ticket.isUrgent, false, locationCity);
            }

            // Unified UI Closure
            await finalizeTopicUIClosure(ctx, String(TEAM_CHATS.SUPPORT), ticket.topicId, closedTitle);
        } catch (e) {
            logger.error({ err: e, ticketId }, "Support topic UI close failed");
        }
    }

    // Check if this was a clarification ticket
    const isClarification = ticket.issueText.includes("❓ Уточнення по завданню");

    // ... rest of UI logic can stay here or be moved to utils
    // For now keeping UI logic here to minimize risk
    if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-ticket-closed"]);
    }

    if (initiator === "ADMIN") {
        const telegramId = Number(ticket.user.telegramId);

        const closureMsg = isClarification
            ? STAFF_TEXTS["support-info-clarification-closed"]
            : STAFF_TEXTS["support-info-closed-notice"];

        // Send SEAMLESS status update
        try {
            const keyboard = new InlineKeyboard().text(STAFF_TEXTS["staff-btn-home"], "staff_hub_nav");
            await sendSupportStatus(ctx, closureMsg, { parse_mode: "HTML", reply_markup: keyboard }, telegramId).catch(() => { });
        } catch (e) {
            logger.error({ err: e, telegramId }, "Support closure notification failed");
        }

        // RE-READING REQUIREMENT: "Seamless logic for photographer... messages from system should replace old ones"
        // If admin closes ticket, it's a system message.
        // I need to be able to delete the previous system message to the user.
        // I should probably add `lastStatusMessageId` to User model or SupportTicket model.
        // Since session is memory/file based and per-key, accessing another user's session is hard without a store.
        // Let's check if we can modify the Schema.
    }
    else {
        if (ctx.callbackQuery?.message) {
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        }
    }

    ctx.session.step = "idle";
}

/**
 * Last-resort safety wrapper. Catches any unhandled error, resets session to
 * safe state, notifies user, and returns true (handled) so the bot never crashes.
 */
async function safeHandle(
    fn: () => Promise<boolean>,
    ctx: MyContext,
    label: string
): Promise<boolean> {
    try {
        return await fn();
    } catch (e) {
        logger.error({ err: e, operation: label }, "Support handler unhandled error");
        logBusinessEvent({
            event: "support.handler.unhandled_error",
            level: "error",
            actorType: "system",
            actorRole: "system",
            telegramId: ctx.from?.id,
            result: "failed",
            reasonCode: "UNHANDLED_SUPPORT_HANDLER_ERROR",
            module: "staff-support-handler",
            operation: label,
            updateId: ctx.update.update_id,
            error: e,
        });
        ctx.session.step = "idle";
        delete ctx.session.ticketId;
        delete ctx.session.clarificationTaskId;
        try {
            await ctx.reply("Сталася помилка. Спробуй ще раз або зверніться до адміністратора. 🌸").catch(() => { });
        } catch { }
        return true;
    }
}

/**
 * Handles messages from Staff Members (Photographers)
 */
async function _handleStaffMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId || !TEAM_CHATS.SUPPORT) {
        logger.debug({ telegramId, supportChatConfigured: Boolean(TEAM_CHATS.SUPPORT) }, "Support staff message skipped");
        return false;
    }

    // Only process private messages for support
    if (ctx.chat?.type !== "private") {
        logger.debug({ telegramId, chatType: ctx.chat?.type }, "Support staff message ignored outside private chat");
        return false;
    }

    // Check if user is Staff
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user || !user.staffProfile) {
        logger.debug({ telegramId }, "Support staff message ignored without active staff profile");
        return false;
    }

    // Shield: Prevent deactivated staff from sending support messages
    if (!user.staffProfile.isActive) {
        logger.warn({ telegramId, userId: user.id }, "Inactive staff support access blocked");
        await ctx.reply(STAFF_TEXTS["staff-deactivated-shield"], { parse_mode: "HTML" }).catch(() => { });
        return true;
    }

    const explicitProofReplySubmissionId = ctx.session.step?.startsWith("awaiting_task_proof_topic_reply_")
        ? ctx.session.step.replace("awaiting_task_proof_topic_reply_", "")
        : null;
    const waitingProofSubmission = explicitProofReplySubmissionId
        ? await taskProofService.getSubmissionById(explicitProofReplySubmissionId)
        : await taskProofService.findLatestWaitingForStaffByStaffId(user.staffProfile.id);

    if (
        explicitProofReplySubmissionId &&
        waitingProofSubmission?.supportTopicId &&
        waitingProofSubmission.supportChatId &&
        waitingProofSubmission.supportTopicStatus !== "CLOSED"
    ) {
        try {
            await ctx.api.copyMessage(Number(waitingProofSubmission.supportChatId), ctx.chat.id, ctx.message!.message_id, {
                message_thread_id: waitingProofSubmission.supportTopicId,
            });

            await taskProofService.markWaitingForSupport(waitingProofSubmission.id);
            ctx.session.step = "idle";
            if (ctx.session.taskProofFlow?.replySubmissionId === waitingProofSubmission.id) {
                delete ctx.session.taskProofFlow.replySubmissionId;
            }

            logBusinessEvent({
                event: "task_proof.staff_reply_forwarded",
                actorType: "staff",
                actorRole: "staff",
                telegramId,
                result: "success",
                module: "staff-support-handler",
                operation: "handleStaffMessage",
                updateId: ctx.update.update_id,
                userId: user.id,
                safeContext: {
                    submissionId: waitingProofSubmission.id,
                    topicId: waitingProofSubmission.supportTopicId,
                    taskId: waitingProofSubmission.taskId,
                },
            });

            return true;
        } catch (err) {
            logger.error({
                err,
                userId: user.id,
                submissionId: waitingProofSubmission.id,
                topicId: waitingProofSubmission.supportTopicId,
            }, "Task proof clarification forwarding failed");
            await ctx.reply("Не вдалося доставити відповідь у topic support. Спробуй ще раз або натисни підтримку.");
            return true;
        }
    }

    // Check Active Ticket
    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);
    logger.debug({
        telegramId,
        userId: user.id,
        hasActiveTicket: Boolean(activeTicket),
        ticketId: activeTicket?.id,
        topicId: activeTicket?.topicId,
        ticketStatus: activeTicket?.status,
    }, "Support ticket state resolved");

    // --- AUTO-AUDIT TICKET LOGIC ---
    const isAuditMsg = (text?: string) => text?.includes("Потрібне уточнення по фінансах");
    const currentText = ctx.message?.text || ctx.message?.caption;
    const repliedText = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption;

    if (!activeTicket && (isAuditMsg(currentText) || isAuditMsg(repliedText))) {
        // This is a reply to an audit question - auto-create ticket
        const sourceText = isAuditMsg(currentText) ? currentText! : repliedText!;
        const locMatch = sourceText.match(/Локація: <b>(.+?)<\/b>/);
        const locationRaw: string = locMatch ? locMatch[1]! : "Unknown";

        try {
            const { supportService } = await import("../../../services/support-service.js");
            // Use current text (the photographer's answer) as the ticket text, with audit context
            const answerText = ctx.message?.text || ctx.message?.caption || "[Медіа]";
            const ticket = await supportService.createTicket(user.id, `Finance Audit Reply: ${answerText}\n\nContext: ${sourceText}`);
            logAuditEvent({
                event: "support.finance_audit_ticket_created",
                telegramId,
                actorType: "staff",
                actorRole: "staff",
                result: "success",
                module: "staff-support-handler",
                operation: "handleStaffMessage",
                updateId: ctx.update.update_id,
                userId: user.id,
                safeContext: {
                    ticketId: ticket.id,
                },
            });

            const topicTitle = `❓ Finance Audit: ${locationRaw.split('(')[0]?.trim() || 'Unknown'}`;
            const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);

            await supportRepository.updateTicket(ticket.id, { topicId: topic.message_thread_id });

            // Send context to topic
            await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, `💰 <b>Finance Audit Reply</b>\n👤 Staff: ${user.staffProfile.fullName}\n\n${sourceText}\n\n<b>Відповідь:</b> ${answerText}`, {
                message_thread_id: topic.message_thread_id,
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔒 Resolve & Close", `admin_close_ticket_${ticket.id}`)
            });

            await ctx.reply("Дякую за відповідь! Твоє пояснення передано кураторам. Якщо будуть додаткові питання — ми напишемо сюди. 🌸");
            return true;
        } catch (e) {
            logger.error({ err: e, telegramId, userId: user.id }, "Support finance audit ticket auto-create failed");
        }
    }

    // Check Active Outgoing Topic (admin-initiated conversation)
    const activeOutgoingTopic = !activeTicket ? await supportRepository.findActiveOutgoingTopicByUser(user.id) : null;
    if (activeOutgoingTopic) {
        logger.debug({ userId: user.id, topicId: activeOutgoingTopic.topicId }, "Active outgoing support topic found");
    }

    if (!explicitProofReplySubmissionId && !activeTicket && !activeOutgoingTopic && waitingProofSubmission?.supportTopicId && waitingProofSubmission.supportChatId) {
        try {
            await ctx.api.copyMessage(Number(waitingProofSubmission.supportChatId), ctx.chat.id, ctx.message!.message_id, {
                message_thread_id: waitingProofSubmission.supportTopicId,
            });
            await taskProofService.markWaitingForSupport(waitingProofSubmission.id);
            logBusinessEvent({
                event: "task_proof.staff_reply_forwarded",
                actorType: "staff",
                actorRole: "staff",
                telegramId,
                result: "success",
                module: "staff-support-handler",
                operation: "handleStaffMessage",
                updateId: ctx.update.update_id,
                userId: user.id,
                safeContext: {
                    submissionId: waitingProofSubmission.id,
                    topicId: waitingProofSubmission.supportTopicId,
                    taskId: waitingProofSubmission.taskId,
                    routing: "implicit_latest_waiting_topic",
                },
            });
            return true;
        } catch (err) {
            logger.error({ err, userId: user.id, submissionId: waitingProofSubmission.id }, "Implicit task proof clarification forwarding failed");
            await ctx.reply("Не вдалося доставити відповідь у topic support. Спробуй ще раз або натисни кнопку «Відповісти» у повідомленні від support.");
            return true;
        }
    }

    // A. If Step is 'reply_and_close' -> Send reply and close ticket
    if (ctx.session.step === "reply_and_close" && ctx.session.ticketId) {
        const ticketId = ctx.session.ticketId;
        const ticket = await supportRepository.findTicketById(ticketId);

        if (!ticket) {
            await ctx.reply(STAFF_TEXTS["support-error-ticket-not-found"]);
            ctx.session.step = "idle";
            delete ctx.session.ticketId;
            return true;
        }

        // Send reply to user
        const replyText = ctx.message?.text || ctx.message?.caption || "";
        try {
            if (ctx.message?.photo) {
                await ctx.api.sendPhoto(Number(ticket.user.telegramId), ctx.message.photo[ctx.message.photo.length - 1]!.file_id, {
                    caption: STAFF_TEXTS["support-info-reply-from-admin"]({ text: escapeHtml(replyText) }),
                    parse_mode: "HTML"
                });
            } else {
                await ctx.api.sendMessage(Number(ticket.user.telegramId), STAFF_TEXTS["support-info-reply-from-admin"]({ text: escapeHtml(replyText) }), { parse_mode: "HTML" });
            }

            // Forward message to support topic if it has media
            if (ticket.topicId && (ctx.message?.photo || ctx.message?.video || ctx.message?.document)) {
                await ctx.api.forwardMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message!.message_id, {
                    message_thread_id: ticket.topicId
                });
            } else if (ticket.topicId) {
                await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, STAFF_TEXTS["support-info-admin-reply-to-topic"]({ replyText: escapeHtml(replyText) }), {
                    message_thread_id: ticket.topicId
                });
            }

            // Update activity timestamp
            await supportRepository.touchTicket(ticket.id).catch(() => { });
            // Close ticket with unified message
            await closeTicket(ctx, ticketId, "ADMIN");
        } catch (e) {
            logger.error({ err: e, ticketId }, "Support reply-and-close delivery failed");
            await ctx.reply(STAFF_TEXTS["support-error-reply-failed"]);
        }

        ctx.session.step = "idle";
        delete ctx.session.ticketId;
        return true;
    }

    // NEW: Handle Broadcast Decline Reason
    if (ctx.session.step === "broadcast_decline_reason") {
        const broadcastId = ctx.session.broadcastId;
        const reason = ctx.message?.text || ctx.message?.caption || "[Медіа]";

        try {
            const { supportService } = await import("../../../services/support-service.js");
            const ticketText = `❌ <b>Не згодна з розсилкою #${broadcastId}</b>\n\n<b>Причина:</b> ${reason}`;
            const ticket = await supportService.createTicket(user.id, ticketText);

            // Create Topic in Support Chat
            const { buildTopicTitle, buildTicketCard, getTicketButtons } = await import("../../../utils/ticket-card.js");

            let locationName = user.staffProfile.location?.name || null;
            let locationCity = user.staffProfile.location?.city || null;
            const closestShift = await workShiftRepository.findClosestShiftWithLocation(user.staffProfile.id, new Date());
            if (closestShift?.location) {
                locationName = closestShift.location.name;
                locationCity = closestShift.location.city;
            }

            const topicTitle = `📣 ${buildTopicTitle(ticket.id, user.staffProfile.fullName, locationName, TicketStatus.OPEN, false, false, locationCity)}`;
            const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);
            const topicId = topic.message_thread_id;

            await supportRepository.updateTicket(ticket.id, { topicId });

            const baseCardText = await buildTicketCard(ticket, user, false, locationName, locationCity);
            const cardText = `📣 <b>BROADCAST OBJECTION</b>\n📝 <b>Broadcast #${broadcastId}</b>\n\n${baseCardText}`;
            const buttons = getTicketButtons(ticket.id, ticket.status);

            await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, cardText, {
                message_thread_id: topicId,
                parse_mode: "HTML",
                reply_markup: buttons
            });

            // Copy user's message to topic
            if (ctx.message && topicId) {
                await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id, {
                    message_thread_id: topicId
                });
            }

            await ctx.reply(STAFF_TEXTS["broadcast-ans-decline"], {
                reply_markup: {
                    inline_keyboard: [[{ text: STAFF_TEXTS["staff-btn-home"], callback_data: "staff_hub_nav" }]]
                }
            });

            ctx.session.step = "idle";
            delete ctx.session.broadcastId;
            return true;
        } catch (e) {
            logger.error({ err: e, broadcastId, userId: user.id }, "Support broadcast decline ticket creation failed");
            ctx.session.step = "idle";
            delete ctx.session.broadcastId;
            await ctx.reply("Сталася помилка. Твій протест не зафіксовано в системі тікетів, але статус розсилки оновлено. Звернись до куратора. 🌸");
            return true;
        }
    }

    // B. If Step is 'create_ticket' -> Create New Ticket
    if (ctx.session.step === "create_ticket") {
        if (activeOutgoingTopic) {
            logger.debug({ userId: user.id, topicId: activeOutgoingTopic.topicId }, "Create ticket step overridden by active outgoing topic");
            ctx.session.step = "idle";
            // Allow this to fall through to forwarding logic below (Section C)
        } else {
            const activeOnboardingCase = await firstShiftOnboardingService.findActiveCaseByTelegramId(telegramId);
            if (activeOnboardingCase) {
                const forwardedToOnboarding = await firstShiftOnboardingService.handleCandidateMessage(ctx.api, telegramId, buildOnboardingPayloadFromSupportMessage(ctx));
                if (forwardedToOnboarding) {
                    ctx.session.step = "idle";
                    delete ctx.session.clarificationTaskId;
                    return true;
                }
            }

            try {
                let text = ctx.message?.text || ctx.message?.caption || "[Медіа]";

                // Add task context if available
                let isClarification = false;
                if (ctx.session.clarificationTaskId) {
                    const { taskService } = await import("../../../services/task-service.js");
                    const task = await taskService.getTaskById(ctx.session.clarificationTaskId);
                    if (task) {
                        const taskDate = task.workDate ? task.workDate.toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit', year: 'numeric' }) : "Без дати";
                        const location = task.locationName || task.city || "Невідомо";
                        const taskPreview = htmlToPlainText(task.taskText);

                        text = `❓ <b>Уточнення по завданню:</b>\n` +
                            `🆔 <b>Task #${task.id.slice(-5)}</b>\n` +
                            `📅 ${escapeHtml(taskDate)} | 📍 ${escapeHtml(location)}\n` +
                            `📝 <i>"${escapeHtml(taskPreview)}"</i>\n\n` +
                            `<b>Питання:</b> ${text}`;
                        isClarification = true;
                    }
                    delete ctx.session.clarificationTaskId;
                }

                // 1. Create Ticket in DB (Status: OPEN)
                const { supportService } = await import("../../../services/support-service.js");
                const ticket = await supportService.createTicket(user.id, text);
                logAuditEvent({
                    event: "support.ticket.created_from_staff_flow",
                    telegramId,
                    actorType: "staff",
                    actorRole: "staff",
                    result: "success",
                    module: "staff-support-handler",
                    operation: "handleStaffMessage",
                    updateId: ctx.update.update_id,
                    userId: user.id,
                    safeContext: {
                        ticketId: ticket.id,
                        isClarification,
                    },
                });

                // 2. Create Topic in Support Chat
                let topicId: number | null = null;
                try {
                    const { buildTopicTitle, buildTicketCard, getTicketButtons } = await import("../../../utils/ticket-card.js");

                    let locationName = user.staffProfile.location?.name || null;
                    let locationCity = user.staffProfile.location?.city || null;
                    const closestShift = await workShiftRepository.findClosestShiftWithLocation(user.staffProfile.id, new Date());
                    if (closestShift?.location) {
                        locationName = closestShift.location.name;
                        locationCity = closestShift.location.city;
                    }
                    const isClarification = text.includes("Уточнення по завданню");
                    const topicTitle = buildTopicTitle(ticket.id, user.staffProfile.fullName, locationName, TicketStatus.OPEN, false, isClarification, locationCity);

                    const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);
                    topicId = topic.message_thread_id;
                    logBusinessEvent({
                        event: "support.ticket.topic_created",
                        actorType: "system",
                        actorRole: "system",
                        telegramId,
                        result: "success",
                        module: "staff-support-handler",
                        operation: "handleStaffMessage",
                        updateId: ctx.update.update_id,
                        userId: user.id,
                        safeContext: {
                            ticketId: ticket.id,
                            topicId,
                            isClarification,
                        },
                    });

                    await supportRepository.updateTicket(ticket.id, { topicId: topicId });

                    // Send Enhanced Ticket Card to Topic
                    const cardText = await buildTicketCard(ticket, user, isClarification, locationName, locationCity);
                    const buttons = getTicketButtons(ticket.id, ticket.status);

                    await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, cardText, {
                        message_thread_id: topicId,
                        parse_mode: "HTML",
                        reply_markup: buttons
                    });

                    // IMPORTANT: Copy original message to support topic
                    if (ctx.message && ctx.chat && topicId !== null) {
                        await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat.id, ctx.message.message_id, {
                            message_thread_id: topicId
                        });
                    }

                } catch (e: any) {
                    logger.error({ err: e, ticketId: ticket.id, userId: user.id }, "Support ticket topic creation failed");

                    // ROLLBACK: Close the ticket immediately so user isn't blocked
                    await supportService.closeTicket(ticket.id);
                    logBusinessEvent({
                        event: "support.ticket.topic_created",
                        level: "error",
                        actorType: "system",
                        actorRole: "system",
                        telegramId,
                        result: "failed",
                        reasonCode: "TOPIC_CREATE_FAILED",
                        module: "staff-support-handler",
                        operation: "handleStaffMessage",
                        updateId: ctx.update.update_id,
                        userId: user.id,
                        safeContext: {
                            ticketId: ticket.id,
                        },
                        error: e,
                    });
                    await ScreenManager.renderScreen(ctx, STAFF_TEXTS["support-error-topic-failed"]({
                        ticketId: ticket.id.toString(),
                        error: e.message || "Telegram API Error"
                    }), new InlineKeyboard().text(STAFF_TEXTS["staff-btn-home"], "staff_hub_nav"), { forceNew: true });

                    ctx.session.step = "idle";
                    return true;
                }

                // 3. Confirm to User based on type
                const confirmText = isClarification
                    ? STAFF_TEXTS["support-info-clarification-sent"]
                    : STAFF_TEXTS["support-info-ticket-created"];

                await ScreenManager.renderScreen(ctx, confirmText, new InlineKeyboard().text(STAFF_TEXTS["staff-btn-home"], "staff_hub_nav"), { forceNew: true });

                ctx.session.step = "idle";
                return true;

            } catch (e) {
                logger.error({ err: e, telegramId, userId: user.id }, "Support ticket creation flow failed");
                ctx.session.step = "idle";
                delete ctx.session.clarificationTaskId;
                const { ScreenManager } = await import("../../../utils/screen-manager.js");
                await ScreenManager.renderScreen(ctx, "Сталася помилка при створенні запиту. Спробуй ще раз або зверніться до адміністратора. 🌸");
                return true;
            }
        }
    }

    // B. If Active Ticket or Outgoing Topic Exists -> Forward Message
    if (activeTicket || activeOutgoingTopic) {
        let targetTopicId = activeTicket?.topicId || activeOutgoingTopic?.topicId;

        // Recovery: If ticket exists but topicId is missing
        if (activeTicket && !activeTicket.topicId) {
            logger.debug({ ticketId: activeTicket.id, userId: user.id }, "Support ticket missing topic, attempting recovery");
            try {
                const { buildTopicTitle } = await import("../../../utils/ticket-card.js");
                let locationName = user.staffProfile.location?.name || null;
                let locationCity = user.staffProfile.location?.city || null;
                const recoveryShift = await workShiftRepository.findClosestShiftWithLocation(user.staffProfile.id, new Date());
                if (recoveryShift?.location) {
                    locationName = recoveryShift.location.name;
                    locationCity = recoveryShift.location.city;
                }
                const topicTitle = buildTopicTitle(activeTicket.id, user.staffProfile.fullName, locationName, TicketStatus.OPEN, false, false, locationCity);
                const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);
                const topicId = topic.message_thread_id;

                // Update DB and local variable
                await supportRepository.updateTicket(activeTicket.id, { topicId });
                activeTicket.topicId = topicId;
                targetTopicId = topicId;

                // Send Intro Card
                await ctx.api.sendMessage(TEAM_CHATS.SUPPORT,
                    `<b>Відновлений тікет #${activeTicket.id}</b>\n👤 <b>${user.staffProfile.fullName}</b> (@${ctx.from?.username || "no_user"})\n\n📄 <i>${activeTicket.issueText}</i>`,
                    {
                        message_thread_id: topicId,
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard().text("🔒 Закрити", `admin_close_ticket_${activeTicket.id}`)
                    }
                );
            } catch (e: any) {
                // If recovery fails, we MUST close the ticket to free the user
                const { supportService } = await import("../../../services/support-service.js");
                await supportService.closeTicket(activeTicket.id);
                await ctx.reply(STAFF_TEXTS["support-error-topic-failed"]({ ticketId: activeTicket.id.toString(), error: "Technical error (autoclosed)" }));
                return true;
            }
        }

        if (targetTopicId) {
            // Forward Message
            try {
                if (ctx.message) {
                    await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id, {
                        message_thread_id: targetTopicId
                    });

                    // Touch updatedAt to track activity
                    if (activeTicket) {
                        await supportRepository.updateTicket(activeTicket.id, { updatedAt: new Date() }).catch(() => { });
                    } else if (activeOutgoingTopic) {
                        await prisma.outgoingTopic.update({
                            where: { id: activeOutgoingTopic.id },
                            data: { updatedAt: new Date() }
                        }).catch(() => { });
                    }

                    // Log to Timeline (Message from Staff)
                    const { timelineRepository } = await import("../../../repositories/timeline-repository.js");
                    await timelineRepository.createEvent(user.id, 'MESSAGE', 'USER', getSupportMessagePreview(ctx.message), {
                        ticketId: activeTicket?.id,
                        outgoingTopicId: activeOutgoingTopic?.id,
                        media: ctx.message.photo ? 'photo' : (ctx.message.video ? 'video' : null)
                    });
                }

                // Update activity timestamp
                if (activeTicket) {
                    await supportRepository.touchTicket(activeTicket.id).catch(() => { });
                }

                return true;
            } catch (e: any) {
                const { rawMessage, isTopicError, isNotForwardable } = classifySupportForwardingError(e);

                logger.error({
                    err: e,
                    userId: user.id,
                    topicId: targetTopicId,
                    ticketId: activeTicket?.id,
                    outgoingTopicId: activeOutgoingTopic?.id,
                    errorMessage: rawMessage,
                    reason: isTopicError ? "topic_unavailable" : (isNotForwardable ? "message_not_forwardable" : "copy_failed"),
                }, "Support topic forwarding failed");

                if (isTopicError) {
                    if (activeTicket) {
                        await supportRepository.updateTicket(activeTicket.id, { topicId: null });
                    } else if (activeOutgoingTopic) {
                        await prisma.outgoingTopic.update({ where: { id: activeOutgoingTopic.id }, data: { isClosed: true } });
                    }
                }

                // Fallback: Send to General (but with context)
                try {
                    if (activeTicket || activeOutgoingTopic) {
                        logger.warn({
                            userId: user.id,
                            topicId: targetTopicId,
                            ticketId: activeTicket?.id,
                            outgoingTopicId: activeOutgoingTopic?.id,
                            reason: isTopicError ? "topic_unavailable" : (isNotForwardable ? "message_not_forwardable" : "copy_failed"),
                        }, "Support topic forwarding fallback activated");

                        const fallbackReasonText = isTopicError
                            ? "Топік не знайдений або недоступний, дублюю в General"
                            : isNotForwardable
                                ? "Telegram не дозволив переслати цей тип повідомлення, дублюю в General"
                                : "Не вдалося доставити повідомлення в топік, дублюю в General";
                        const fallbackIntro = activeTicket
                            ? `🆘 <b>Повідомлення від фотографа до тікету #${activeTicket.id}</b>\n` +
                            `👤 <b>${user.staffProfile.fullName}</b>\n` +
                            `<i>(${fallbackReasonText})</i>`
                            : `🆘 <b>Відповідь фотографа (Outgoing Topic conversation)</b>\n` +
                            `👤 <b>${user.staffProfile.fullName}</b>\n` +
                            `<i>(${fallbackReasonText})</i>`;

                        await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, fallbackIntro, { parse_mode: "HTML" });
                        if (ctx.message) {
                            if (isNotForwardable) {
                                await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, buildSupportFallbackBody(ctx.message), { parse_mode: "HTML" });
                            } else {
                                try {
                                    await ctx.api.forwardMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id);
                                } catch {
                                    await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, buildSupportFallbackBody(ctx.message), { parse_mode: "HTML" });
                                }
                            }
                        }
                    }
                } catch (fallbackErr: any) {
                    logger.error({
                        err: fallbackErr,
                        userId: user.id,
                        topicId: targetTopicId,
                        ticketId: activeTicket?.id,
                        outgoingTopicId: activeOutgoingTopic?.id,
                    }, "Support fallback forwarding failed");
                }
                return true;
            }
        }
    }

    // C. No Ticket and Not creating one -> Return false to allow stray message handler to take over
    return false;
}

export async function handleStaffMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    return safeHandle(() => _handleStaffMessage(ctx, bot), ctx, "handleStaffMessage");
}

/**
 * Handles messages in the Support Group (Admins replying to Staff)
 */
async function _handleSupportGroupMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    const allowedTopicChats = [Number(TEAM_CHATS.SUPPORT), Number(RECOVERY_CHAT_ID)];
    if (!allowedTopicChats.includes(Number(ctx.chat?.id))) return false;
    if (!ctx.message?.message_thread_id) return false; // Must be in a topic

    // Loop Prevention: Filter role and source
    // 1. Ignore message from bot itself
    if (ctx.from?.id === ctx.me.id) return false;

    const senderRole = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!senderRole) {
        logger.warn({ telegramId: ctx.from?.id, topicId: ctx.message.message_thread_id }, "Blocked support-group message from non-admin sender");
        return false;
    }

    const topicId = ctx.message.message_thread_id;

    // Find Ticket by Topic
    const ticket = await supportRepository.findTicketByTopicId(topicId);

    if (!ticket || ticket.status === TicketStatus.CLOSED) {
        const proofSubmission = await taskProofService.findBySupportTopic(BigInt(ctx.chat!.id), topicId);
        if (proofSubmission && proofSubmission.supportTopicStatus !== "CLOSED") {
            try {
                const targetTelegramId = Number(proofSubmission.staff.user.telegramId);
                await sendAdminOutboundMessage(ctx, targetTelegramId, { prefixText: false });
                await taskProofService.markWaitingForStaff(proofSubmission.id);

                const task = proofSubmission.task;
                const keyboard = new InlineKeyboard().text("💬 Відповісти", `staff_task_proof_reply_${proofSubmission.id}`);
                const taskPreview = truncateText(htmlToPlainText(task.taskText), 180);
                const hintText =
                    `💬 <b>Уточнення від support по завданню</b>\n` +
                    `📍 ${escapeHtml(task.locationName || proofSubmission.staff.location?.name || "Локація не вказана")}\n` +
                    `<i>${escapeHtml(taskPreview)}</i>\n\n` +
                    `Натисни кнопку нижче і надішли відповідь сюди. Я передам її в правильний topic.`;
                await sendSupportStatus(ctx, hintText, { parse_mode: "HTML", reply_markup: keyboard }, targetTelegramId);

                logBusinessEvent({
                    event: "task_proof.support_reply_forwarded",
                    actorType: "admin",
                    actorRole: "admin",
                    telegramId: ctx.from?.id,
                    result: "success",
                    module: "staff-support-handler",
                    operation: "handleSupportGroupMessage",
                    updateId: ctx.update.update_id,
                    userId: proofSubmission.staff.userId,
                    safeContext: {
                        submissionId: proofSubmission.id,
                        topicId,
                        taskId: proofSubmission.taskId,
                    },
                });
                return true;
            } catch (e: any) {
                logger.error({ err: e, topicId, submissionId: proofSubmission.id }, "Task proof support reply forwarding failed");
                const errorMsg = e.description?.includes("blocked")
                    ? "❌ Не вдалося доставити уточнення: фотограф заблокував бота."
                    : "❌ Не вдалося доставити уточнення фотографу.";
                await ctx.reply(errorMsg, { message_thread_id: topicId });
                return true;
            }
        }

        // Not a standard ticket — check if it's an OutgoingTopic (admin-initiated conversation)
        const outgoingTopic = await supportRepository.findOutgoingTopicByTopicId(topicId);
        if (!outgoingTopic || !outgoingTopic.userId) return false;

        const staffUser = await userRepository.findById(outgoingTopic.userId);
        if (!staffUser) return false;

        try {
            const targetTelegramId = Number(staffUser.telegramId);
            await sendAdminOutboundMessage(ctx, targetTelegramId, { prefixText: false });

            // Touch updatedAt to track activity
            await prisma.outgoingTopic.update({
                where: { id: outgoingTopic.id },
                data: { updatedAt: new Date() }
            }).catch(() => { });

            // Log to Timeline
            const { timelineRepository } = await import("../../../repositories/timeline-repository.js");
            const adminText = ctx.message?.text || ctx.message?.caption || "[Media Reply]";
            await timelineRepository.createEvent(staffUser.id, 'MESSAGE', 'ADMIN', adminText, {
                outgoingTopicId: outgoingTopic.id,
                adminId: ctx.from?.id,
                adminName: ctx.from?.first_name
            });

            logBusinessEvent({
                event: "support.outgoing_topic.reply_forwarded",
                actorType: "admin",
                actorRole: "admin",
                telegramId: ctx.from?.id,
                result: "success",
                module: "staff-support-handler",
                operation: "handleSupportGroupMessage",
                updateId: ctx.update.update_id,
                userId: staffUser.id,
                safeContext: {
                    topicId,
                    outgoingTopicId: outgoingTopic.id,
                    targetTelegramId,
                },
            });
            return true;
        } catch (e: any) {
            logger.error({ err: e, topicId, targetTelegramId: Number(staffUser.telegramId) }, "Support outgoing topic reply forwarding failed");
            const errorMsg = e.description?.includes("blocked")
                ? "❌ Failed to deliver the message (user blocked the bot)."
                : "❌ Failed to deliver the message to the user.";
            await ctx.reply(errorMsg, { message_thread_id: topicId });
            return true;
        }
    }

    // Forward to User (Staff or Candidate fallback)
    const user = await userRepository.findWithStaffProfileById(ticket.userId);
    let telegramId: number;

    // Resolve target telegram ID (support both Staff and Candidates)
    if (!user || !user.staffProfile) {
        const candidateUser = await userRepository.findById(ticket.userId);
        if (!candidateUser) return false;
        telegramId = Number(candidateUser.telegramId);
    } else {
        telegramId = Number(user.telegramId);
    }

    try {
        await sendAdminOutboundMessage(ctx, telegramId, { prefixText: false });

        // Touch updatedAt to track activity
        await supportRepository.updateTicket(ticket.id, { updatedAt: new Date() }).catch(() => { });

        // --- NEW: Handle Auto-Assign on Reply ---
        if (ticket.status === TicketStatus.OPEN && ctx.from) {
            const { getAdminRoleByTelegramId } = await import("../../../config/roles.js");
            const adminRole = getAdminRoleByTelegramId(BigInt(ctx.from.id));

            // Only auto-assign for core support roles
            if (adminRole && ["SUPER_ADMIN", "CO_FOUNDER", "SUPPORT"].includes(adminRole)) {
                const adminUser = await userRepository.findByTelegramId(BigInt(ctx.from.id));
                if (adminUser) {
                    await supportRepository.updateTicket(ticket.id, {
                        status: TicketStatus.IN_PROGRESS,
                        assignedAdminId: adminUser.id
                    });

                    // Visual update (Topic title)
                    await updateTicketVisuals(ctx, ticket.id);
                    logAuditEvent({
                        event: "support.ticket.auto_assigned_on_reply",
                        telegramId: ctx.from?.id,
                        actorType: "admin",
                        actorRole: adminRole,
                        result: "success",
                        module: "staff-support-handler",
                        operation: "handleSupportGroupMessage",
                        updateId: ctx.update.update_id,
                        userId: adminUser.id,
                        safeContext: {
                            ticketId: ticket.id,
                        },
                    });
                }
            }
        }
        // ----------------------------------------

        // --- NEW: Handle Reply & Close flow ---
        if (ctx.session.step === "reply_and_close" && ctx.session.ticketId === ticket.id) {
            await closeTicket(ctx, ticket.id, "ADMIN");
            ctx.session.step = "idle";
            delete ctx.session.ticketId;
            return true;
        }
        // --------------------------------------

        logBusinessEvent({
            event: "support.ticket.reply_forwarded",
            actorType: "admin",
            actorRole: "admin",
            telegramId: ctx.from?.id,
            result: "success",
            module: "staff-support-handler",
            operation: "handleSupportGroupMessage",
            updateId: ctx.update.update_id,
            userId: ticket.userId,
            safeContext: {
                ticketId: ticket.id,
                topicId,
                targetTelegramId: telegramId,
            },
        });

        // Update activity timestamp
        await supportRepository.touchTicket(ticket.id).catch(() => { });

        // Status Update & Topic Rename: ONLY FOR STAFF
        // (Previously some logic was here)

        // Log to Timeline (Message from Admin to Staff/Candidate)
        const { timelineRepository } = await import("../../../repositories/timeline-repository.js");
        const adminText = ctx.message?.text || ctx.message?.caption || "[Media Reply]";

        await timelineRepository.createEvent(ticket.userId, 'MESSAGE', 'ADMIN', adminText, {
            ticketId: ticket.id,
            adminId: ctx.from?.id,
            adminName: ctx.from?.first_name
        });

        return true;
    } catch (e: any) {
        logger.error({ err: e, ticketId: ticket.id, userId: ticket.userId }, "Support ticket reply delivery failed");
        logBusinessEvent({
            event: "support.ticket.reply_forwarded",
            level: "warn",
            actorType: "admin",
            actorRole: "admin",
            telegramId: ctx.from?.id,
            result: "failed",
            reasonCode: "USER_DELIVERY_FAILED",
            module: "staff-support-handler",
            operation: "handleSupportGroupMessage",
            updateId: ctx.update.update_id,
            userId: ticket.userId,
            safeContext: {
                ticketId: ticket.id,
                topicId,
            },
            error: e,
        });
        const errorMsg = e.description?.includes("blocked")
            ? "❌ Failed to deliver the message (user blocked the bot)."
            : "❌ Failed to deliver the message to the user.";
        await ctx.reply(errorMsg, { message_thread_id: topicId });
        return true;
    }
}


// Not wrapped in safeHandle: _handleSupportGroupMessage already has its own try/catch
// and runs in group context where ctx.reply() would send to the wrong chat.
export async function handleSupportGroupMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    return _handleSupportGroupMessage(ctx, bot);
}
