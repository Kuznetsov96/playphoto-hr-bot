import fs from "fs";
import path from "path";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";

/**
 * Service to handle automatic log cleanup.
 * Prevents the product.log file from growing indefinitely since logrotate is not available.
 */
export class LogCleanupService {
    private static LOG_PATH = "/app/logs/product.log";

    /**
     * Truncates the log file to 0 bytes.
     * Scheduled for the 1st of every month at 04:00 AM Kyiv time.
     */
    static async cleanup() {
        const now = new Date();
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const triggerKey = `log_cleanup_triggered:${kyivNow.getFullYear()}-${kyivNow.getMonth() + 1}`;
        
        // 1. Check in Redis to prevent multiple cleanups if container restarts
        const alreadyTriggered = await redis.get(triggerKey);
        if (alreadyTriggered) {
            return;
        }

        logger.info("🧹 Starting scheduled log cleanup (Monthly)...");

        try {
            if (fs.existsSync(this.LOG_PATH)) {
                // Get file size before cleanup for logging
                const stats = fs.statSync(this.LOG_PATH);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                // Truncate file to 0 bytes (this keeps the file descriptor valid for Pino)
                fs.truncateSync(this.LOG_PATH, 0);
                
                logger.info(`✅ Log file cleaned. Freed ${sizeMB} MB.`);
            } else {
                logger.warn(`📂 Log file not found at ${this.LOG_PATH}, skipping cleanup.`);
            }

            // 2. Mark as triggered for this month
            await redis.set(triggerKey, "true", "EX", 32 * 24 * 60 * 60); 
        } catch (e: any) {
            logger.error({ err: e.message }, "❌ Failed to cleanup logs");
        }
    }

    /**
     * Checks if it's the 1st of the month and triggers cleanup at 04:00 AM.
     */
    static async checkAndTrigger() {
        const now = new Date();
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        
        // Trigger on the 1st, at 04:00 AM Kyiv time
        if (kyivDate.getDate() === 1 && kyivDate.getHours() === 4 && kyivDate.getMinutes() === 0) {
            await this.cleanup();
        }
    }
}

export function startLogCleanupLoop() {
    logger.info("🧹 Starting log cleanup loop (Monthly on the 1st)...");
    // Check every minute
    setInterval(() => LogCleanupService.checkAndTrigger(), 60 * 1000);
}
