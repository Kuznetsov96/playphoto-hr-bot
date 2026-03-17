import { supportRepository } from "../repositories/support-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";
import { SUPPORT_CHAT_ID } from "../config.js";
import { Bot, Api } from "grammy";
import type { MyContext } from "../types/context.js";
import { TicketStatus } from "@prisma/client";
import { escapeHtml } from "../handlers/admin/utils.js";
import { getAdminRoleByTelegramId } from "../config/roles.js";

import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

const t = (key: string, args?: any) => {
    // @ts-ignore
    const text = ADMIN_TEXTS[key] || STAFF_TEXTS[key];
    if (typeof text === 'function') return text(args || {});
    return text || key;
};


export class SupportService {
    async sendMessageToStaff(api: Api, userId: string, text: string, isTask: boolean = false) {
        const user = await userRepository.findWithStaffProfileById(userId);
        if (!user) throw new Error("User not found");

        let ticket = await supportRepository.findActiveTicketByUser(userId);

        if (!ticket) {
            ticket = await supportRepository.createTicket({
                userId,
                issueText: "[From Admin]",
                status: "OPEN"
            });
        }

        // Ensure topic exists in support chat
        if (!ticket.topicId && SUPPORT_CHAT_ID) {
            try {
                const topicName = `🎫 #${ticket.id} | ${user.staffProfile?.fullName || user.username || userId}`;
                const topic = await api.createForumTopic(SUPPORT_CHAT_ID, topicName);
                await supportRepository.updateTicket(ticket.id, { topicId: topic.message_thread_id });
                ticket.topicId = topic.message_thread_id;
            } catch (e) {
                logger.error({ err: e }, "Failed to create forum topic");
            }
        }

        // Send to user
        try {
            await api.sendMessage(Number(user.telegramId), text, { parse_mode: "HTML" });

            // Log in support chat
            if (ticket.topicId && SUPPORT_CHAT_ID) {
                const adminPrefix = isTask ? `📝 <b>TASK:</b>\n` : `💬 <b>Admin:</b>\n`;
                const escapedText = escapeHtml(text);
                await api.sendMessage(SUPPORT_CHAT_ID, adminPrefix + escapedText, {
                    message_thread_id: ticket.topicId,
                    parse_mode: "HTML"
                });
            }
            return true;
        } catch (e) {
            logger.error({ err: e, telegramId: user.telegramId }, "Error sending message to staff");
            throw e;
        }
    }

    async getTicket(id: number) {
        return supportRepository.findTicketById(id);
    }

    async closeTicket(id: number) {
        return supportRepository.updateTicket(id, { status: "CLOSED" });
    }

    async getTicketSummary(id: number): Promise<string> {
        const ticket = await supportRepository.findTicketById(id);
        if (!ticket) return t("admin-ticket-not-found");

        const staffName = ticket.user.staffProfile?.fullName || "Unknown";
        const statusKey = ticket.status === "OPEN" ? "admin-ticket-status-new" : (ticket.status === "IN_PROGRESS" ? "admin-ticket-status-inprogress" : "admin-ticket-status-closed");
        const status = t(statusKey);

        const date = ticket.createdAt.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
        const urgent = ticket.isUrgent ? t("admin-ticket-summary-urgent") + "\n" : "";

        return t("admin-ticket-summary-header", { id: ticket.id }) + "\n" +
            t("admin-ticket-summary-status", { status }) + "\n" +
            t("admin-ticket-summary-created", { date }) + "\n" +
            t("admin-ticket-summary-author", { name: staffName }) + "\n\n" +
            `${urgent}` +
            t("admin-ticket-summary-issue") + "\n" +
            `<i>${ticket.issueText}</i>`;
    }
    async createTicket(userId: string, text: string, topicId?: number) {
        // 1. Create Ticket in DB
        const ticket = await supportRepository.createTicket({
            userId,
            status: "OPEN",
            issueText: text,
            isUrgent: false,
            topicId: topicId ?? null
        });

        // 2. Create Topic logic (moved from handler)
        // We return the ticket and let the handler deal with Telegram-specifics like sending messages if complex
        // OR we encapsulate the topic creation here if we pass the API.
        // For now, let's keep it simple: Service does DB + Business Logic. 
        // Handler does Telegram UI (sending messages).
        // But wait, the previous sendMessageToStaff used API. 

        return ticket;
    }

    async assignTicket(ticketId: number, adminTelegramId: number) {
        const ticket = await supportRepository.findTicketById(ticketId);
        if (!ticket) throw new Error("Ticket not found");
        if (ticket.status === "CLOSED") throw new Error("Ticket is closed");

        // Authorization: only admins can assign tickets
        if (!getAdminRoleByTelegramId(BigInt(adminTelegramId))) {
            logger.warn({ adminTelegramId, ticketId }, "⛔ Unauthorized ticket assign attempt");
            throw new Error("Недостатньо прав для цієї дії");
        }

        // Resolve admin's database ID (CUID) from Telegram ID
        const adminUser = await userRepository.findByTelegramId(BigInt(adminTelegramId));
        if (!adminUser) throw new Error("Admin user not found in DB");

        await supportRepository.updateTicket(ticketId, {
            status: "IN_PROGRESS",
            assignedAdminId: adminUser.id // Use CUID, not Telegram ID
        });

        return ticket;
    }

    async toggleUrgent(ticketId: number) {
        const ticket = await supportRepository.findTicketById(ticketId);
        if (!ticket) throw new Error("Ticket not found");

        const newUrgent = !ticket.isUrgent;
        await supportRepository.updateTicket(ticketId, { isUrgent: newUrgent });

        return { ticket, newUrgent };
    }

    async transferTicket(ticketId: number, targetAdminId: bigint, initiatorId: number) {
        const ticket = await supportRepository.findTicketById(ticketId);
        if (!ticket || ticket.status === "CLOSED") throw new Error("Ticket closed or not found");

        // Authorization: only admins can transfer tickets
        if (!getAdminRoleByTelegramId(BigInt(initiatorId))) {
            logger.warn({ initiatorId, ticketId }, "⛔ Unauthorized ticket transfer attempt");
            throw new Error("Недостатньо прав для цієї дії");
        }

        // Update ticket assignment
        const targetAdmin = await userRepository.findByTelegramId(targetAdminId);
        if (!targetAdmin) throw new Error("Target admin not found");

        await supportRepository.updateTicket(ticketId, {
            assignedAdminId: targetAdmin.id,
            status: "IN_PROGRESS"
        });

        return { ticket, targetAdmin };
    }
}

export const supportService = new SupportService();
