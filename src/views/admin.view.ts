import { TicketStatus } from "@prisma/client";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";

/**
 * Presenters for Admin UI.
 * Encapsulates HTML formatting and emoji logic.
 */
export const adminView = {
    /**
     * Dashboard header for Tickets
     */
    renderTicketsDashboard: (stats: { urgent: number, open: number, inProgress: number }) => {
        return `🛠️ <b>Tickets Dashboard</b>\n\n` +
               `Select a category to view active support requests:\n\n` +
               `🆘 Urgent: <b>${stats.urgent}</b>\n` +
               `🟡 New: <b>${stats.open}</b>\n` +
               `🟠 In Progress: <b>${stats.inProgress}</b>`;
    },

    /**
     * Header for a specific ticket list
     */
    renderTicketListHeader: (filter: string, count: number) => {
        const titleMap: Record<string, string> = {
            "urgent": "🆘 Urgent Tickets",
            "OPEN": "🟡 New Tickets",
            "IN_PROGRESS": "🟠 In Progress Tickets",
            "CLOSED": "✖️ Closed Tickets"
        };
        return `🎫 <b>${titleMap[filter] || "Tickets"}</b> (${count})\n\nSelect a ticket to view details:`;
    },

    /**
     * Formatting a single ticket button label
     */
    formatTicketLabel: (t: any) => {
        const fullName = t.user?.staffProfile?.fullName || t.user?.firstName || "Unknown";
        const firstName = fullName.split(' ')[0] || "Unknown";
        const icon = t.isUrgent ? "🆘" : (t.status === TicketStatus.OPEN ? "🟡" : (t.status === TicketStatus.IN_PROGRESS ? "🟠" : "✖️"));
        return `${icon} #${t.id} | ${firstName}`;
    }
};
