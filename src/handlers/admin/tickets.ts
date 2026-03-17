import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { TicketStatus } from "@prisma/client";
import { getTopicLink } from "../../utils/ticket-card.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { adminView } from "../../views/admin.view.js";

/**
 * Controller for Tickets Dashboard.
 */
export async function showTicketsDashboard(ctx: MyContext) {
    const { supportRepository } = ctx.di;
    
    const [urgentCount, openCount, inProgressCount] = await Promise.all([
        supportRepository.countUrgent(),
        supportRepository.countByStatus(TicketStatus.OPEN),
        supportRepository.countByStatus(TicketStatus.IN_PROGRESS)
    ]);

    const text = adminView.renderTicketsDashboard({
        urgent: urgentCount,
        open: openCount,
        inProgress: inProgressCount
    });

    const kb = new InlineKeyboard()
        .text(`🆘 Urgent (${urgentCount})`, "ticket_list_urgent").row()
        .text(`🟡 New (${openCount})`, `ticket_list_${TicketStatus.OPEN}`)
        .text(`🟠 In Progress (${inProgressCount})`, `ticket_list_${TicketStatus.IN_PROGRESS}`).row()
        .text("✖️ Recently Closed (Last 10)", `ticket_list_${TicketStatus.CLOSED}`).row()
        .text(ADMIN_TEXTS["admin-ops-back"], "admin_system_back");

    await ScreenManager.renderScreen(ctx, text, kb, { 
        pushToStack: true,
        manualMenuId: "admin-tickets"
    });
}

/**
 * Controller for rendering a list of tickets based on filter.
 */
export async function renderTicketList(ctx: MyContext, filter: string) {
    const { supportRepository } = ctx.di;
    let tickets: any[] = [];

    if (filter === "urgent") {
        tickets = await supportRepository.findUrgentTickets();
    } else if (filter === TicketStatus.CLOSED) {
        tickets = await supportRepository.findTicketsByStatus(filter, 10);
    } else {
        tickets = await supportRepository.findTicketsByStatus(filter as TicketStatus);
    }

    const text = adminView.renderTicketListHeader(filter, tickets.length);
    const kb = new InlineKeyboard();

    if (tickets.length === 0) {
        kb.text("No tickets found 📭", "none").row();
    } else {
        for (const t of tickets) {
            kb.text(adminView.formatTicketLabel(t), `ticket_view_${t.id}`).row();
        }
    }

    kb.text("⬅️ Back to Dashboard", "admin_tickets_dashboard").row();
    kb.text(ADMIN_TEXTS["admin-ops-back"], "admin_system_back");

    await ScreenManager.renderScreen(ctx, text, kb, { 
        pushToStack: true,
        manualMenuId: `admin-tickets-list-${filter}`
    });
}

/**
 * Controller for rendering individual ticket details.
 */
export async function showTicketDetails(ctx: MyContext, ticketId: number) {
    const { supportService, supportRepository } = ctx.di;
    
    const detailText = await supportService.getTicketSummary(ticketId);
    const t = await supportRepository.findTicketById(ticketId);
    if (!t) return ctx.answerCallbackQuery("Ticket not found.");

    const kb = new InlineKeyboard();

    if (t.topicId) {
        const link = getTopicLink(t.topicId);
        kb.url("➡️ Go to Topic", link);
    }

    kb.row().text("✍️ Quick Reply", `admin_reply_to_${t.user.telegramId}`);
    kb.row().text(ADMIN_TEXTS["support-btn-force-close"], `ticket_force_close_${t.id}`);
    kb.row().text("⬅️ Back to List", "back_to_ticket_list");

    await ScreenManager.renderScreen(ctx, detailText, kb, { pushToStack: true });
    await ctx.answerCallbackQuery();
}
