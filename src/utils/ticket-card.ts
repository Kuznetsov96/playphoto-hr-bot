import { InlineKeyboard } from "grammy";
import type { TicketStatus, AdminRole } from "@prisma/client";
import { userRepository } from "../repositories/user-repository.js";
import * as CONFIG from "../config.js";
import { shortenName } from "./string-utils.js";
import { escapeHtml } from "../handlers/admin/utils.js";

/**
 * Location shortcut lookup by "name|city" composite key.
 * Keys use DB location names + Ukrainian city names as stored in DB.
 */
const LOCATION_SHORTCUTS: Record<string, string> = {
    // Lviv
    "Leolend|Львів": "Leo",
    "Drive City|Львів": "Drive",
    "Dragon Park|Львів": "Drag",
    "Fly Kids|Львів": "Patona",
    "Smile Park|Львів": "PidDubom",

    // Kyiv
    "Smile Park|Київ": "SP",
    "Smile Park (Darynok)|Київ": "Dar",
    "Fly Kids|Київ": "FKK",

    // Zaporizhzhia
    "Volkland|Запоріжжя": "Volk",
    "Volkland 2|Запоріжжя": "Volk2",
    "Volkland 3|Запоріжжя": "Volk3",

    // Others
    "Karamel|Коломия": "Kolom",
    "Karamel|Шептицький": "She",
    "Fly Kids|Рівне": "FKRiv",
    "Fantasy Town|Черкаси": "FKChe",
    "Smile Park|Харків": "SPKha",
    "Karamel|Самбір": "Samb",
    "Dytyache Horyshche|Хмельницький": "HM",
};

/**
 * Helper to get the best shortcut for a location
 */
function getLocationShortcut(name: string, city: string | null): string {
    // 1. Try composite key match (name|city)
    if (city) {
        const key = `${name}|${city}`;
        if (LOCATION_SHORTCUTS[key]) return LOCATION_SHORTCUTS[key];
    }

    // 2. Try matching by name with any city (for unique location names)
    for (const [compositeKey, code] of Object.entries(LOCATION_SHORTCUTS)) {
        const keyName = compositeKey.split('|')[0]!;
        if (keyName === name) return code;
    }

    // 3. Fallback: first 3 letters
    return name.substring(0, 3);
}

/**
 * Builds a detailed ticket card for the support chat
 */
export async function buildTicketCard(
    ticket: {
        id: number;
        status: TicketStatus;
        isUrgent: boolean;
        assignedAdminId: string | null;
        createdAt: Date;
    },
    user: {
        telegramId: bigint;
        username: string | null;
        staffProfile: {
            fullName: string;
            location: {
                name: string;
                city: string | null;
            } | null;
        } | null;
        candidate: {
            location: {
                name: string;
                city: string | null;
            } | null;
        } | null;
    },
    isClarification: boolean = false,
    locationNameOverride: string | null = null,
    locationCityOverride: string | null = null,
    isOnboarding: boolean = false
): Promise<string> {
    const statusIcons = {
        OPEN: "⚠️ <b>OPEN</b>",
        IN_PROGRESS: "🟠 <b>IN PROGRESS</b>",
        CLOSED: "✖️ <b>CLOSED</b>"
    };

    const urgentPrefix = ticket.isUrgent ? "🆘 <b>URGENT</b> | " : "";
    const statusText = statusIcons[ticket.status];
    const username = user.username ? `@${escapeHtml(user.username)}` : null;
    const fullName = escapeHtml(user.staffProfile?.fullName || "Unknown");

    // Location with city
    let locationText = "Unknown";
    
    if (locationNameOverride) {
        locationText = locationCityOverride ? `${locationNameOverride} (${locationCityOverride})` : locationNameOverride;
    } else {
        const loc = user.staffProfile?.location || user.candidate?.location;
        if (loc) {
            locationText = loc.city ? `${loc.name} (${loc.city})` : loc.name;
        } else if (fullName.includes("FK")) {
            locationText = fullName.split(' ').pop() || "Unknown";
        }
    }
    locationText = escapeHtml(locationText);

    // Format creation date
    const createdDate = ticket.createdAt.toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Build compact card
    const clarHeader = isClarification ? "❓ <b>TASK CLARIFICATION</b>\n" : "";
    const onboardHeader = isOnboarding ? "🎓 <b>ОНБОРДИНГ (ПЕРША ЗМІНА)</b>\n" : "";
    let card = `${onboardHeader}${clarHeader}${urgentPrefix}🎫 <b>Ticket #${ticket.id}</b> | ${statusText}\n\n`;
    card += `👤 ${shortenName(fullName)}`;
    if (username) card += ` (${username})`;
    card += `\n`;
    card += `📍 ${locationText}\n`;
    card += `🕐 ${createdDate}\n`;

    return card;
}

/**
 * Gets the topic icon based on ticket status, urgency, and assigned admin role.
 *
 * ⚠️  OPEN (not taken)
 * 🆘  Urgent
 * 🟠  IN_PROGRESS — support / default
 * 🔵  IN_PROGRESS — assigned to head admin (SUPER_ADMIN)
 * 🟣  IN_PROGRESS — assigned to co-founder
 * ✖️  CLOSED
 */
export function getTopicIcon(status: TicketStatus, isUrgent: boolean, assignedAdminRole?: AdminRole | null): string {
    if (isUrgent) return "🆘";

    switch (status) {
        case "OPEN": return "⚠️";
        case "IN_PROGRESS": {
            if (assignedAdminRole === "SUPER_ADMIN") return "🔵";
            if (assignedAdminRole === "CO_FOUNDER") return "🟣";
            return "🟠";
        }
        case "CLOSED": return "✖️";
        default: return "⚠️";
    }
}

/**
 * Builds the topic title for a ticket
 * Format: [Icon] #ID | LocationCode | FirstName
 */
export function buildTopicTitle(
    ticketId: number,
    fullName: string,
    locationName: string | null,
    status: TicketStatus,
    isUrgent: boolean,
    isClarification: boolean = false,
    locationCity: string | null = null,
    assignedAdminId: string | null = null,
    assignedAdminRole: AdminRole | null = null
): string {
    const icon = getTopicIcon(status, isUrgent, assignedAdminRole);
    const clarIcon = isClarification ? " ❓" : "";
    const firstName = fullName.split(' ')[0] || fullName;
    const locationCode = locationName ? getLocationShortcut(locationName, locationCity) : "?";

    return `${icon}${clarIcon} #${ticketId} | ${locationCode} | ${firstName}`;
}

/**
 * Gets inline keyboard buttons based on ticket status
 */
export function getTicketButtons(
    ticketId: number, 
    status: TicketStatus, 
    isSimplified: boolean = false,
    isOnboarding: boolean = false,
    candidateId: string | null = null
): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    // Get admin IDs for transfer buttons
    const SUPER_ADMIN_ID = CONFIG.ADMIN_IDS[0] || 0;
    const CO_FOUNDER_ID = CONFIG.CO_FOUNDER_IDS[0] || 0;

    if (status === "OPEN") {
        keyboard.text("🙋‍♀️ Take", `ticket_assign_${ticketId}`).row();
        keyboard.text("🆘 Urgent", `ticket_urgent_${ticketId}`);
        keyboard.text("✅ Close", `ticket_close_${ticketId}`);
    } else if (status === "IN_PROGRESS") {
        keyboard.text("✅ Reply & Close", `ticket_reply_close_${ticketId}`).row();

        if (!isSimplified) {
            keyboard.text("🙋‍♀️ Reclaim", `ticket_assign_${ticketId}`);
            keyboard.text("👤 Head Admin", `ticket_transfer_${ticketId}_${SUPER_ADMIN_ID}`);
            keyboard.text("👤 Co-founder", `ticket_transfer_${ticketId}_${CO_FOUNDER_ID}`).row();
            keyboard.text("🆘 Urgent", `ticket_urgent_${ticketId}`);
        }

        keyboard.text("❌ Close", `ticket_close_${ticketId}`);
    } else {
        // CLOSED - no buttons
        return keyboard;
    }

    if (isOnboarding && candidateId) {
        keyboard.row();
        keyboard.text("✅ Pass Staging", `onboard_pass_${candidateId}_${ticketId}`);
        keyboard.text("❌ Fail", `onboard_fail_${candidateId}_${ticketId}`);
    }

    return keyboard;
}

/**
 * Generates a clickable link to a forum topic
 */
export function getTopicLink(topicId: number): string {
    const chatId = String(CONFIG.SUPPORT_CHAT_ID).replace("-100", "");
    return `https://t.me/c/${chatId}/${topicId}`;
}
