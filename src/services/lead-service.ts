import { LeadPlatform, LeadStatus } from "@prisma/client";
import { leadRepository } from "../repositories/lead-repository.js";
import { TEAM_CHATS } from "../config.js";
import { type Api, InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { extractFirstName } from "../utils/string-utils.js";
import { workUABrowserService } from "./work-ua-browser-service.js";
import { olxService } from "./olx-service.js";

const PLATFORM_ICONS: Record<LeadPlatform, string> = {
    [LeadPlatform.INSTAGRAM]: "📸",
    [LeadPlatform.OLX]: "🟦",
    [LeadPlatform.WORK_UA]: "💼",
    [LeadPlatform.MANUAL]: "📝"
};

const STATUS_ICONS: Record<LeadStatus, string> = {
    [LeadStatus.NEW]: "🆕",
    [LeadStatus.INVITED]: "📩",
    [LeadStatus.IN_PROGRESS]: "💬",
    [LeadStatus.CONVERTED]: "✅",
    [LeadStatus.CLOSED]: "📁"
};

export class LeadService {
    /**
     * Main entry point for incoming messages from external platforms.
     */
    async handleIncomingMessage(api: Api, data: any) {
        return null;
    }

    /**
     * Creates or updates a Telegram topic for a specific lead.
     */
    private async syncWithTopic(api: Api, leadId: string, lastMessage?: string, metadata?: any) {
        return;
    }

    /**
     * Internal method to create a new topic.
     */
    private async createNewTopic(api: Api, lead: any, lastMessage?: string, metadata?: any) {
        return;
    }

    /**
     * Formats message content (bold headers, trim).
     */
    private formatMessageContent(text: string): string {
        return text;
    }

    /**
     * Generates a random friendly invitation message for Work.ua.
     */
    private getWorkUAInviteText(fullName: string): string {
        return "";
    }

    /**
     * Sends a pre-defined invitation message to the lead.
     */
    async sendInvitation(api: Api, leadId: string): Promise<{ success: boolean, manual?: boolean }> {
        return { success: false, manual: true };
    }

    /**
     * Forwards a custom HR response to the platform.
     */
    async sendCustomResponse(api: Api, topicId: number, text: string) {
        return false;
    }

    /**
     * Sends messages to external platforms.
     */
    private async sendMessageToPlatform(platform: LeadPlatform, externalId: string, text: string): Promise<boolean> {
        return false; 
    }

    async closeLead(api: Api, leadId: string) {
        return;
    }
}

export const leadService = new LeadService();
