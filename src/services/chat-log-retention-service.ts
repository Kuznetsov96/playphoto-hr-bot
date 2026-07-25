import logger from "../core/logger.js";
import { redis } from "../core/redis.js";
import { logBusinessEvent } from "../core/log-events.js";
import { chatLogRepository } from "../repositories/chat-log-repository.js";

/**
 * Retention for the ChatLog table (bot correspondence history).
 *
 * Policy (confirmed 2026-07-25):
 * - active staff: history is never deleted;
 * - former staff: full archive kept for 3 years after dismissal (deactivatedAt);
 * - candidates and unregistered users: 180 days.
 */
export class ChatLogRetentionService {
    static NON_STAFF_RETENTION_DAYS = 180;
    static FORMER_STAFF_ARCHIVE_YEARS = 3;

    static async cleanup() {
        const now = new Date();
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const triggerKey = `chatlog_retention_triggered:${kyivNow.getFullYear()}-${kyivNow.getMonth() + 1}-${kyivNow.getDate()}`;

        const alreadyTriggered = await redis.get(triggerKey);
        if (alreadyTriggered) {
            return;
        }

        logBusinessEvent({
            event: "chatlog.retention.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "chat-log-retention-service",
            operation: "cleanup",
        });

        try {
            const ageCutoff = new Date(now.getTime() - this.NON_STAFF_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            const deactivatedCutoff = new Date(now);
            deactivatedCutoff.setFullYear(deactivatedCutoff.getFullYear() - this.FORMER_STAFF_ARCHIVE_YEARS);

            const deletedCount = await chatLogRepository.deleteExpired(ageCutoff, deactivatedCutoff);

            logBusinessEvent({
                event: "chatlog.retention.completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "chat-log-retention-service",
                operation: "cleanup",
                safeContext: {
                    deletedCount,
                    ageCutoff: ageCutoff.toISOString(),
                    deactivatedCutoff: deactivatedCutoff.toISOString(),
                },
            });

            await redis.set(triggerKey, "true", "EX", 2 * 24 * 60 * 60);
        } catch (e: any) {
            logger.error({ err: e }, "ChatLog retention cleanup failed");
            logBusinessEvent({
                event: "chatlog.retention.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "chat-log-retention-service",
                operation: "cleanup",
                error: e,
            });
        }
    }

    /**
     * Runs daily at 04:15 Kyiv time (after the 04:00 DB backup).
     */
    static async checkAndTrigger() {
        const now = new Date();
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

        if (kyivDate.getHours() === 4 && kyivDate.getMinutes() === 15) {
            await this.cleanup();
        }
    }
}

export function startChatLogRetentionLoop() {
    logBusinessEvent({
        event: "chatlog.retention_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "chat-log-retention-service",
        operation: "startChatLogRetentionLoop",
    });
    setInterval(() => ChatLogRetentionService.checkAndTrigger(), 60 * 1000);
}
