import { olxService } from "./olx-service.js";
import { leadService } from "./lead-service.js";
import { type Bot } from "grammy";
import { type MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { LeadPlatform } from "@prisma/client";
import prisma from "../db/core.js";

export class OLXWorker {
    private isRunning = false;

    async start(bot: Bot<MyContext>) {
        if (this.isRunning) return;
        this.isRunning = true;

        logger.info("🚀 [OLX Worker] Started polling for new messages");

        // Initial check
        await this.poll(bot).catch(e => logger.error({ err: e }, "OLX Poll error"));

        // Interval: every 2 minutes
        setInterval(async () => {
            await this.poll(bot).catch(e => logger.error({ err: e }, "OLX Poll error"));
        }, 2 * 60 * 1000);
    }

    private async poll(bot: Bot<MyContext>) {
        const threads = await olxService.getThreads();
        if (!threads || threads.length === 0) return;

        for (const thread of threads) {
            // thread.unread_count might be useful, but let's check messages
            if (thread.unread_count > 0) {
                await this.processThread(bot, thread);
            }
        }
    }

    private async processThread(bot: Bot<MyContext>, thread: any) {
        const messages = await olxService.getMessages(thread.id);
        if (!messages || messages.length === 0) return;

        // OLX Messages usually have 'interlocutor_id' or 'user_id'
        // We need to identify who is the candidate and who is us.
        // Usually, if direction is 'incoming', it's from candidate.
        
        // Find latest unread messages
        const incomingMessages = messages.filter((m: any) => m.type === "incoming" && m.is_read === false);
        
        if (incomingMessages.length === 0) return;

        // Get candidate info (OLX API v2 thread usually has interlocutor info)
        const candidateName = thread.interlocutor?.name || "OLX Candidate";
        const externalId = String(thread.interlocutor?.id || thread.id);

        for (const msg of incomingMessages) {
            await leadService.handleIncomingMessage(bot.api, {
                externalId: externalId,
                platformThreadId: String(thread.id),
                platformAdId: String(thread.advert_id),
                platform: LeadPlatform.OLX,
                name: candidateName,
                text: msg.text,
            });
            
            // Mark as read would be good, but OLX API might not have a simple "mark as read" endpoint
            // or it happens automatically on getMessages (depends on API version/config)
        }
    }
}

export const olxWorker = new OLXWorker();
