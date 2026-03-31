import fs from "fs";
import path from "path";
import logger from "../core/logger.js";
import { productDestination } from "../core/logger.js";
import { redis } from "../core/redis.js";
import { logBusinessEvent } from "../core/log-events.js";

/**
 * Service to handle automatic log cleanup.
 * Rotates product.log monthly to preserve incident history without unbounded growth.
 */
export class LogCleanupService {
    private static LOG_DIR = "/app/logs";
    private static LOG_PATH = "/app/logs/product.log";

    /**
     * Rotates the current log into a month-stamped archive and reopens the destination.
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
        logBusinessEvent({
            event: "logs.product.rotation.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "log-cleanup-service",
            operation: "cleanup",
        });

        try {
            if (fs.existsSync(this.LOG_PATH)) {
                const stats = fs.statSync(this.LOG_PATH);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                const archiveName = `product-${kyivNow.getFullYear()}-${String(kyivNow.getMonth() + 1).padStart(2, "0")}.log`;
                const archivePath = path.join(this.LOG_DIR, archiveName);

                fs.renameSync(this.LOG_PATH, archivePath);
                productDestination?.reopen();
                this.purgeOldArchives();

                logger.info({ archiveName, sizeMB }, "✅ Product log rotated");
                logBusinessEvent({
                    event: "logs.product.rotation.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "log-cleanup-service",
                    operation: "cleanup",
                    safeContext: { archiveName, sizeMB },
                });
            } else {
                logger.warn(`📂 Log file not found at ${this.LOG_PATH}, skipping cleanup.`);
                logBusinessEvent({
                    event: "logs.product.rotation.completed",
                    level: "warn",
                    actorType: "system",
                    actorRole: "system",
                    result: "skipped",
                    reasonCode: "PRODUCT_LOG_FILE_MISSING",
                    module: "log-cleanup-service",
                    operation: "cleanup",
                });
            }

            // 2. Mark as triggered for this month
            await redis.set(triggerKey, "true", "EX", 32 * 24 * 60 * 60); 
        } catch (e: any) {
            logger.error({ err: e.message }, "❌ Failed to cleanup logs");
            logBusinessEvent({
                event: "logs.product.rotation.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "log-cleanup-service",
                operation: "cleanup",
                error: e,
            });
        }
    }

    private static purgeOldArchives() {
        try {
            const files = fs.readdirSync(this.LOG_DIR);
            const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

            for (const file of files) {
                if (!file.startsWith("product-") || !file.endsWith(".log")) continue;
                const filePath = path.join(this.LOG_DIR, file);
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(filePath);
                    logger.info({ file }, "🗑 Deleted old product log archive");
                }
            }
        } catch (e: any) {
            logger.error({ err: e.message }, "❌ Failed to purge old product log archives");
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
    logBusinessEvent({
        event: "logs.product.rotation_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "log-cleanup-service",
        operation: "startLogCleanupLoop",
    });
    // Check every minute
    setInterval(() => LogCleanupService.checkAndTrigger(), 60 * 1000);
}
