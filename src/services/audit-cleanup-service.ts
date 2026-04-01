import fs from "fs";
import path from "path";
import logger from "../core/logger.js";
import { auditDestination } from "../core/audit-logger.js";
import { redis } from "../core/redis.js";
import { logAuditEvent, logBusinessEvent } from "../core/log-events.js";

/**
 * Quarterly rotation for audit.log.
 * Unlike product.log (truncated monthly), audit logs are preserved longer.
 * Archived files kept for 365 days.
 */
export class AuditCleanupService {
    private static LOG_DIR = "/app/logs";
    private static LOG_PATH = "/app/logs/audit.log";

    /** Quarter months: Jan=0, Apr=3, Jul=6, Oct=9 */
    private static QUARTER_MONTHS = [0, 3, 6, 9];

    static async rotate() {
        const now = new Date();
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const quarter = Math.floor(kyivNow.getMonth() / 3) + 1;
        const triggerKey = `audit_cleanup_triggered:${kyivNow.getFullYear()}-Q${quarter}`;

        const alreadyTriggered = await redis.get(triggerKey);
        if (alreadyTriggered) return;

        logAuditEvent({
            event: "logs.audit.rotation.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "audit-cleanup-service",
            operation: "rotate",
        });

        try {
            if (fs.existsSync(this.LOG_PATH)) {
                const stats = fs.statSync(this.LOG_PATH);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                const archiveName = `audit-${kyivNow.getFullYear()}-Q${quarter}.log`;
                const archivePath = path.join(this.LOG_DIR, archiveName);

                fs.renameSync(this.LOG_PATH, archivePath);

                // Reopen Pino destination so it creates a fresh audit.log
                auditDestination.reopen();

                logAuditEvent({
                    event: "logs.audit.rotation.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "audit-cleanup-service",
                    operation: "rotate",
                    safeContext: { archiveName, sizeMB, quarter },
                });
            }

            // Delete archived audit logs older than 365 days
            this.purgeOldArchives();

            await redis.set(triggerKey, "true", "EX", 100 * 24 * 60 * 60);
        } catch (e: any) {
            logger.error({ err: e }, "Audit log rotation failed");
            logAuditEvent({
                event: "logs.audit.rotation.completed",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "audit-cleanup-service",
                operation: "rotate",
                safeContext: { quarter },
                error: e,
            });
        }
    }

    private static purgeOldArchives() {
        try {
            const files = fs.readdirSync(this.LOG_DIR);
            const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;

            for (const file of files) {
                if (!file.startsWith("audit-") || !file.endsWith(".log")) continue;
                const filePath = path.join(this.LOG_DIR, file);
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(filePath);
                    logger.debug({ file }, "Old audit log archive deleted");
                }
            }
        } catch (e: any) {
            logger.error({ err: e }, "Old audit log archive purge failed");
        }
    }

    static async checkAndTrigger() {
        const now = new Date();
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

        // Trigger on 1st of quarter month at 05:00 (one hour after product.log cleanup)
        if (
            this.QUARTER_MONTHS.includes(kyivDate.getMonth()) &&
            kyivDate.getDate() === 1 &&
            kyivDate.getHours() === 5 &&
            kyivDate.getMinutes() === 0
        ) {
            await this.rotate();
        }
    }
}

export function startAuditCleanupLoop() {
    logBusinessEvent({
        event: "logs.audit.rotation_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "audit-cleanup-service",
        operation: "startAuditCleanupLoop",
    });
    setInterval(() => AuditCleanupService.checkAndTrigger(), 60 * 1000);
}
