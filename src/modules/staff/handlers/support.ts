import { STAFF_TEXTS } from "../../../constants/staff-texts.js";

import logger from "../../../core/logger.js";
import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import { SUPPORT_CHAT_ID, TEAM_CHATS } from "../../../config.js";
import { userRepository } from "../../../repositories/user-repository.js";
import { supportRepository } from "../../../repositories/support-repository.js";
import { staffRepository } from "../../../repositories/staff-repository.js";
import { candidateRepository } from "../../../repositories/candidate-repository.js";
import { statsService } from "../../../services/stats-service.js";
import prisma from "../../../db/core.js";
import { workShiftRepository } from "../../../repositories/work-shift-repository.js";
import { TicketStatus } from "@prisma/client";
import { updateTicketVisuals, sendSupportStatus, finalizeTopicUIClosure } from "../../../handlers/support-utils.js";
import { escapeHtml } from "../../../handlers/admin/utils.js";
import { ScreenManager } from "../../../utils/screen-manager.js";

// Statuses that are considered "Active"
const ACTIVE_STATUSES = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS];

export const staffSupportHandlers = new Composer<MyContext>();

// 1. Start Ticket Creation Flow
staffSupportHandlers.callbackQuery("staff_help", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

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
    await ctx.answerCallbackQuery();
    const text = STAFF_TEXTS["support-ask-issue"];

    const kb = new InlineKeyboard();

    // Add Logistics button for Support role
    const { getUserAdminRole } = await import("../../../middleware/role-check.js");
    const role = await getUserAdminRole(BigInt(telegramId));
    if (role === 'SUPPORT' || role === 'SUPER_ADMIN' || role === 'CO_FOUNDER') {
        kb.text("📦 Logistics", "admin_logistics_nav").row();
    }

    kb.text(STAFF_TEXTS["hr-btn-cancel"], "staff_hub_nav");

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
        reply_markup: new InlineKeyboard().text(STAFF_TEXTS["hr-btn-cancel"], "cancel_step")
    });
});

// 6. Toggle Urgent Flag
staffSupportHandlers.callbackQuery(/^ticket_urgent_(\d+)$/, async (ctx) => {
    const ticketId = Number(ctx.match[1]);

    try {
        const { supportService } = await import("../../../services/support-service.js");
        const { newUrgent } = await supportService.toggleUrgent(ticketId);

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
        await finalizeTopicUIClosure(ctx, String(SUPPORT_CHAT_ID), topicId, newTitle);

    } catch (e: any) {
        logger.error({ err: e, topicId }, "Failed to close outgoing topic");
        await ctx.answerCallbackQuery(`❌ Error: ${e.message}`);
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
    await supportService.closeTicket(ticketId);

    // Try to close topic silently
    if (ticket.topicId) {
        try {
            await ctx.api.closeForumTopic(SUPPORT_CHAT_ID, ticket.topicId);
        } catch (e) {
            logger.warn({ err: e, ticketId }, "Failed to close topic during force close");
        }
    }

    await ctx.answerCallbackQuery(STAFF_TEXTS["support-ans-force-closed"]);
    await ctx.editMessageText(STAFF_TEXTS["support-info-force-closed"]({ ticketId: ticketId.toString() }), {
        reply_markup: new InlineKeyboard().text(STAFF_TEXTS["hr-menu-back-home"], "admin_main_back"),
    });
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
            logger.error({ err: e }, "❌ Failed to send DM to target admin");
        }

        // Refresh ticket card in support chat
        await updateTicketVisuals(ctx, ticketId);

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

    // Close in DB via Service
    await supportService.closeTicket(ticketId);

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
            logger.error({ err: e }, "Failed to close topic UI");
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
        } catch (e) { logger.error({ err: e }, "❌ Failed to send seamless closure message to user"); }

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
        logger.error({ err: e }, `💥 [SUPPORT] Unhandled error in ${label}`);
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
    const logMsg = (msg: string) => {
        logger.info(msg);
    };

    logMsg(`📨 [SUPPORT] handleStaffMessage ENTRY for user ${ctx.from?.id} in chat ${ctx.chat?.id} (${ctx.chat?.type})`);
    const telegramId = ctx.from?.id;
    if (!telegramId || !TEAM_CHATS.SUPPORT) {
        logMsg(`❌ [SUPPORT] EXIT: No telegramId or SUPPORT chat`);
        return false;
    }

    // Only process private messages for support
    if (ctx.chat?.type !== "private") {
        logMsg(`❌ [SUPPORT] EXIT: Not a private chat`);
        return false;
    }

    // Check if user is Staff
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (!user || !user.staffProfile) {
        logMsg(`❌ [SUPPORT] EXIT: No staff profile found for ${telegramId}`);
        return false;
    }

    // Shield: Prevent deactivated staff from sending support messages
    if (!user.staffProfile.isActive) {
        logMsg(`❌ [SUPPORT] EXIT: Staff profile for ${telegramId} is INACTIVE`);
        await ctx.reply(STAFF_TEXTS["staff-deactivated-shield"], { parse_mode: "HTML" }).catch(() => { });
        return true;
    }

    logMsg(`✅ [SUPPORT] Staff identified: ${user.staffProfile.fullName} (Active: ${user.staffProfile.isActive}, UserId: ${user.id})`);

    // Check Active Ticket
    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);
    logMsg(`🔍 [SUPPORT] Active ticket check: ${activeTicket ? `Found #${activeTicket.id}, topicId: ${activeTicket.topicId}, status: ${activeTicket.status}` : 'No active ticket'}`);

    // --- AUTO-AUDIT TICKET LOGIC ---
    if (!activeTicket && ctx.message?.text?.includes("Потрібне уточнення по фінансах")) {
        // This is a reply to an audit question - auto-create ticket
        const locMatch = ctx.message.text.match(/Локація: <b>(.+?)<\/b>/);
        const locationRaw: string = locMatch ? locMatch[1]! : "Unknown";

        try {
            const { supportService } = await import("../../../services/support-service.js");
            const ticket = await supportService.createTicket(user.id, `Finance Audit Reply: ${ctx.message.text}`);

            const topicTitle = `❓ Finance Audit: ${locationRaw.split('(')[0]?.trim() || 'Unknown'}`;
            const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);

            await supportRepository.updateTicket(ticket.id, { topicId: topic.message_thread_id });

            // Send context to topic
            await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, `💰 <b>Finance Audit Reply</b>\n👤 Staff: ${user.staffProfile.fullName}\n\n${ctx.message.text}`, {
                message_thread_id: topic.message_thread_id,
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔒 Resolve & Close", `admin_close_ticket_${ticket.id}`)
            });

            await ctx.reply("Дякую за відповідь! Твоє пояснення передано кураторам. Якщо будуть додаткові питання — ми напишемо сюди. 🌸");
            return true;
        } catch (e) {
            logger.error({ err: e }, "Failed to auto-create audit ticket");
        }
    }

    // Check Active Outgoing Topic (admin-initiated conversation)
    const activeOutgoingTopic = !activeTicket ? await supportRepository.findActiveOutgoingTopicByUser(user.id) : null;
    if (activeOutgoingTopic) {
        logMsg(`🔍 [SUPPORT] Active Outgoing Topic check: Found topicId ${activeOutgoingTopic.topicId}`);
    }

    logMsg(`🔍 [SUPPORT] Session step: ${ctx.session.step}`);
    logMsg(`🔍 [SUPPORT] Message text: ${ctx.message?.text || ctx.message?.caption || '[media]'}`);

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
            logger.error({ err: e }, "❌ Failed to send reply");
            await ctx.reply(STAFF_TEXTS["support-error-reply-failed"]);
        }

        ctx.session.step = "idle";
        delete ctx.session.ticketId;
        return true;
    }

    // B. If Step is 'create_ticket' -> Create New Ticket
    if (ctx.session.step === "create_ticket") {
        if (activeOutgoingTopic) {
            logMsg(`⚠️ [SUPPORT] Overriding create_ticket step because an Active Outgoing Topic exists`);
            ctx.session.step = "idle";
            // Allow this to fall through to forwarding logic below (Section C)
        } else {
            const logMsg = (msg: string) => logger.info(msg);
            logMsg(`📝 [SUPPORT] Creating new ticket for ${user.staffProfile.fullName}`);
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

                        text = `❓ <b>Уточнення по завданню:</b>\n` +
                            `🆔 <b>Task #${task.id.slice(-5)}</b>\n` +
                            `📅 ${taskDate} | 📍 ${location}\n` +
                            `📝 <i>"${task.taskText}"</i>\n\n` +
                            `<b>Питання:</b> ${text}`;
                        isClarification = true;
                    }
                    delete ctx.session.clarificationTaskId;
                }

                // 1. Create Ticket in DB (Status: OPEN)
                const { supportService } = await import("../../../services/support-service.js");
                const ticket = await supportService.createTicket(user.id, text);

                // 2. Create Topic in Support Chat
                let topicId: number | null = null;
                try {
                    // Create topic with location shortcut
                    logger.info(`🎫 [SUPPORT] Creating topic in ${TEAM_CHATS.SUPPORT} for staff ${user.staffProfile.fullName}`);
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
                    logger.info(`✅ [SUPPORT] Topic created: ID ${topicId}`);

                    await supportRepository.updateTicket(ticket.id, { topicId: topicId });

                    // Send Enhanced Ticket Card to Topic
                    const cardText = await buildTicketCard(ticket, user, isClarification);
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
                        logMsg(`✅ [SUPPORT] New ticket #${ticket.id} created and message copied to topic ${topicId}`);
                    }

                } catch (e: any) {
                    logMsg(`❌ [SUPPORT] Failed to create topic for new ticket: ${e.message}`);
                    logger.error({ err: e }, "❌ Failed to create topic");

                    // ROLLBACK: Close the ticket immediately so user isn't blocked
                    await supportService.closeTicket(ticket.id);
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
                logger.error({ err: e }, "❌ [SUPPORT] Failed to create ticket in create_ticket branch");
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
            logMsg(`⚠️ [SUPPORT] Ticket #${activeTicket.id} has NO topicId, attempting recovery`);
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
                logMsg(`✅ [SUPPORT] Topic recovery successful: created topic ${topicId} for ticket #${activeTicket.id}`);
            } catch (e: any) {
                logMsg(`❌ [SUPPORT] Topic recovery FAILED for ticket #${activeTicket.id}: ${e.message}`);

                // If recovery fails, we MUST close the ticket to free the user
                const { supportService } = await import("../../../services/support-service.js");
                await supportService.closeTicket(activeTicket.id);
                await ctx.reply(STAFF_TEXTS["support-error-topic-failed"]({ ticketId: activeTicket.id.toString(), error: "Technical error (autoclosed)" }));
                return true;
            }
        }

        if (targetTopicId) {
            logMsg(`🎫 [SUPPORT] Processing active topic ${targetTopicId}`);

            // Forward Message
            try {
                logMsg(`📡 [SUPPORT] Attempting to copy message to topic ${targetTopicId}`);
                if (ctx.message) {
                    await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id, {
                        message_thread_id: targetTopicId
                    });

                    // Touch updatedAt to track activity
                    if (activeTicket) {
                        await supportRepository.updateTicket(activeTicket.id, { updatedAt: new Date() }).catch(() => {});
                    } else if (activeOutgoingTopic) {
                        await prisma.outgoingTopic.update({
                            where: { id: activeOutgoingTopic.id },
                            data: { updatedAt: new Date() }
                        }).catch(() => {});
                    }
                    
                    logMsg(`✅ [SUPPORT] Message copied successfully to topic ${targetTopicId}, returning true`);

                    // Touch updatedAt to track activity
                    if (activeTicket) {
                        await supportRepository.updateTicket(activeTicket.id, { updatedAt: new Date() }).catch(() => { });
                    } else if (activeOutgoingTopic) {
                        await prisma.outgoingTopic.update({
                            where: { id: activeOutgoingTopic.id },
                            data: { updatedAt: new Date() }
                        }).catch(() => { });
                    }

                    logMsg(`✅ [SUPPORT] Message copied successfully to topic ${targetTopicId}, returning true`);
                    // Log to Timeline (Message from Staff)
                    const { timelineRepository } = await import("../../../repositories/timeline-repository.js");
                    await timelineRepository.createEvent(user.id, 'MESSAGE', 'USER', ctx.message.text || ctx.message.caption || "[Media Message]", {
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
                logMsg(`❌ [SUPPORT] Forward FAILED to topic ${targetTopicId}: ${e.message}`);

                // Broad detection for topic issues: clear topicId in DB for ANY error related to message thread
                const isTopicError = e.message?.toLowerCase().includes("thread") ||
                    e.message?.toLowerCase().includes("topic") ||
                    e.message?.toLowerCase().includes("not found");

                if (isTopicError) {
                    if (activeTicket) {
                        logMsg(`⚠️ [SUPPORT] Topic error detected, clearing topicId ${activeTicket.topicId} for ticket #${activeTicket.id}`);
                        await supportRepository.updateTicket(activeTicket.id, { topicId: null });
                    } else if (activeOutgoingTopic) {
                        logMsg(`⚠️ [SUPPORT] Topic error detected, closing outgoing topic ${activeOutgoingTopic.topicId}`);
                        await prisma.outgoingTopic.update({ where: { id: activeOutgoingTopic.id }, data: { isClosed: true } });
                    }
                }

                // Fallback: Send to General (but with context)
                try {
                    if (activeTicket || activeOutgoingTopic) {
                        logger.warn(`⚠️ [SUPPORT] Falling back to General for user ${user.id}`);
                        const fallbackIntro = activeTicket
                            ? `🆘 <b>Повідомлення від фотографа до тікету #${activeTicket.id}</b>\n` +
                            `👤 <b>${user.staffProfile.fullName}</b>\n` +
                            `<i>(Топік був не знайдений або виникла помилка, пересилаю в General)</i>`
                            : `🆘 <b>Відповідь фотографа (Outgoing Topic conversation)</b>\n` +
                            `👤 <b>${user.staffProfile.fullName}</b>\n` +
                            `<i>(Топік був не знайдений або виникла помилка, пересилаю в General)</i>`;

                        await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, fallbackIntro, { parse_mode: "HTML" });
                        if (ctx.message) {
                            await ctx.api.forwardMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id);
                        }
                    }
                } catch (fallbackErr: any) {
                    logMsg(`💥 [SUPPORT] FALLBACK ALSO FAILED: ${fallbackErr.message}`);
                }
                return true;
            }
        }
    }

    // C. No Ticket and Not creating one -> Return false to allow stray message handler to take over
    logMsg(`ℹ️ [SUPPORT] Staff ${user.id} has no active ticket and not in create_ticket mode, falling through`);
    return false;
}

export async function handleStaffMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    return safeHandle(() => _handleStaffMessage(ctx, bot), ctx, "handleStaffMessage");
}

/**
 * Handles messages in the Support Group (Admins replying to Staff)
 */
async function _handleSupportGroupMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    if (ctx.chat?.id !== Number(TEAM_CHATS.SUPPORT)) return false;
    if (!ctx.message?.message_thread_id) return false; // Must be in a topic

    // Loop Prevention: Filter role and source
    // 1. Ignore message from bot itself
    if (ctx.from?.id === ctx.me.id) return false;

    const topicId = ctx.message.message_thread_id;

    // Find Ticket by Topic
    const ticket = await supportRepository.findTicketByTopicId(topicId);

    if (!ticket || ticket.status === TicketStatus.CLOSED) {
        // Not a standard ticket — check if it's an OutgoingTopic (admin-initiated conversation)
        const outgoingTopic = await supportRepository.findOutgoingTopicByTopicId(topicId);
        if (!outgoingTopic || !outgoingTopic.userId) return false;

        const staffUser = await userRepository.findWithStaffProfileById(outgoingTopic.userId);
        if (!staffUser || !staffUser.staffProfile) return false;

        try {
            const telegramId = Number(staffUser.telegramId);
            await ctx.copyMessage(telegramId);

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

            logger.info({ topicId, telegramId }, "[SUPPORT] Outgoing topic reply forwarded to photographer");
            return true;
        } catch (e: any) {
            logger.error({ err: e }, `[SUPPORT] Failed to forward outgoing topic reply to photographer`);
            const errorMsg = e.description?.includes("blocked")
                ? "❌ Не вдалося доставити повідомлення (користувач заблокував бота)."
                : "❌ Не вдалося доставити повідомлення користувачу.";
            await ctx.reply(errorMsg, { message_thread_id: topicId });
            return true;
        }
    }

    // Forward to User (STAFF ONLY logic)
    const user = await userRepository.findWithStaffProfileById(ticket.userId);
    if (!user || !user.staffProfile) {
        // Not a staff ticket, let candidate logic handle it
        return false;
    }

    try {
        const telegramId = Number(user.telegramId);
        await ctx.copyMessage(telegramId);

        // Touch updatedAt to track activity
        await supportRepository.updateTicket(ticket.id, { updatedAt: new Date() }).catch(() => {});

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
                    logger.info({ ticketId: ticket.id, adminId: adminUser.id, role: adminRole }, "🎫 [SUPPORT] Ticket auto-assigned on reply");
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

        logger.info({ topicId, ticketId: ticket.id }, "[SUPPORT] Message forwarded to user, ticket touched");

        // Update activity timestamp
        await supportRepository.touchTicket(ticket.id).catch(() => { });

        // Status Update & Topic Rename: ONLY FOR STAFF
        // (Previously some logic was here)

        // Log to Timeline (Message from Admin to Staff)
        const { timelineRepository } = await import("../../../repositories/timeline-repository.js");
        const adminText = ctx.message?.text || ctx.message?.caption || "[Media Reply]";

        await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', adminText, {
            ticketId: ticket.id,
            adminId: ctx.from?.id,
            adminName: ctx.from?.first_name
        });

        return true;
    } catch (e: any) {
        logger.error({ err: e }, `Failed to send reply to user ${ticket.userId}`);
        const errorMsg = e.description?.includes("blocked")
            ? "❌ Не вдалося доставити повідомлення (користувач заблокував бота)."
            : "❌ Не вдалося доставити повідомлення користувачу.";
        await ctx.reply(errorMsg, { message_thread_id: topicId });
        return true;
    }
}


// Not wrapped in safeHandle: _handleSupportGroupMessage already has its own try/catch
// and runs in group context where ctx.reply() would send to the wrong chat.
export async function handleSupportGroupMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    return _handleSupportGroupMessage(ctx, bot);
}
