import { Bot, InlineKeyboard } from "grammy";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { NDA_LINK } from "../config.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import logger from "../core/logger.js";

export const remindersService = {
    async processNDAReminders(botApi: any) {
        logger.info("🕒 Checking for candidates awaiting NDA confirmation (12h+)...");
        
        try {
            // Find candidates who got NDA more than 12 hours ago and haven't confirmed or been reminded yet
            const candidates = await candidateRepository.findAwaitingNDAReminder(12);
            
            if (candidates.length === 0) {
                logger.info("✅ No candidates need NDA reminders at this time.");
                return;
            }

            logger.info(`🔔 Found ${candidates.length} candidates for NDA reminder.`);

            for (const cand of candidates) {
                try {
                    const firstName = extractFirstName(cand.fullName || "");
                    const kb = new InlineKeyboard().text("✅ Ознайомлена з NDA", `confirm_nda_${cand.id}`);
                    
                    await botApi.sendMessage(Number(cand.user.telegramId),
                        CANDIDATE_TEXTS["nda-reminder"](firstName, NDA_LINK),
                        { parse_mode: "HTML", reply_markup: kb }
                    );

                    // Mark as reminded to avoid double automatic ping
                    await candidateRepository.update(cand.id, { ndaReminderSentAt: new Date() } as any);
                    logger.info(`✅ Auto-ping sent to ${cand.fullName} (TG: ${cand.user.telegramId})`);
                } catch (e) {
                    logger.error({ err: e, candId: cand.id }, "❌ Failed to send automated NDA reminder");
                }
            }
        } catch (e) {
            logger.error({ err: e }, "❌ Error processing NDA reminders");
        }
    },

    startRemindersLoop(botApi: any) {
        logger.info("🕒 Starting automated NDA reminders loop (every 15m)...");
        // Check every 15 minutes
        setInterval(() => this.processNDAReminders(botApi), 15 * 60 * 1000);
        // Also run immediately on start
        this.processNDAReminders(botApi);
    }
};
