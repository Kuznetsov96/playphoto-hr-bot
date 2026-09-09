import { Bot, InlineKeyboard } from "grammy";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { NDA_LINK } from "../config.js";
import { extractFirstName } from "../utils/string-utils.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { isBotBlocked, handleBlockedCandidate } from "../utils/bot-blocked.js";

export const remindersService = {

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
        // Also run immediately on start
    }
};
