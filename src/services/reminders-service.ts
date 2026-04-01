import { Bot, InlineKeyboard } from "grammy";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { NDA_LINK } from "../config.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";

export const remindersService = {
    async processNDAReminders(botApi: any) {
        logBusinessEvent({
            event: "candidate.nda_legacy_reminder_scan.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "reminders-service",
            operation: "processNDAReminders",
        });
        
        try {
            // Find candidates who got NDA more than 12 hours ago and haven't confirmed or been reminded yet
            const candidates = await candidateRepository.findAwaitingNDAReminder(12);
            
            if (candidates.length === 0) {
                logBusinessEvent({
                    event: "candidate.nda_legacy_reminder_scan.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "reminders-service",
                    operation: "processNDAReminders",
                    safeContext: { candidateCount: 0 },
                });
                return;
            }

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
                    logBusinessEvent({
                        event: "candidate.nda_legacy_reminder_sent",
                        candidateId: cand.id,
                        telegramId: cand.user.telegramId,
                        actorType: "system",
                        actorRole: "system",
                        stage: "NDA",
                        result: "success",
                        module: "reminders-service",
                        operation: "processNDAReminders",
                    });
                } catch (e) {
                    logger.error({ err: e, candidateId: cand.id }, "Legacy NDA reminder delivery failed");
                    logBusinessEvent({
                        event: "candidate.nda_legacy_reminder_sent",
                        level: "warn",
                        candidateId: cand.id,
                        telegramId: cand.user?.telegramId,
                        actorType: "system",
                        actorRole: "system",
                        stage: "NDA",
                        result: "failed",
                        reasonCode: "TELEGRAM_DELIVERY_FAILED",
                        module: "reminders-service",
                        operation: "processNDAReminders",
                        error: e,
                    });
                }
            }
            logBusinessEvent({
                event: "candidate.nda_legacy_reminder_scan.completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "reminders-service",
                operation: "processNDAReminders",
                safeContext: { candidateCount: candidates.length },
            });
        } catch (e) {
            logger.error({ err: e }, "Legacy NDA reminder processing failed");
            logBusinessEvent({
                event: "candidate.nda_legacy_reminder_scan.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "reminders-service",
                operation: "processNDAReminders",
                error: e,
            });
        }
    },

    startRemindersLoop(botApi: any) {
        logBusinessEvent({
            event: "candidate.nda_legacy_reminder_loop.started",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "reminders-service",
            operation: "startRemindersLoop",
            safeContext: { intervalMinutes: 15 },
        });
        // Check every 15 minutes
        setInterval(() => this.processNDAReminders(botApi), 15 * 60 * 1000);
        // Also run immediately on start
        this.processNDAReminders(botApi);
    }
};
