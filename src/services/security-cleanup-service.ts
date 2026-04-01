import fs from "fs";
import path from "path";
import logger from "../core/logger.js";
import { securityDestination } from "../core/audit-logger.js";
import { redis } from "../core/redis.js";
import { logBusinessEvent, logSecurityEvent } from "../core/log-events.js";

/**
 * Quarterly rotation for security.log.
 * Security archives are retained longer than audit archives.
 */
export class SecurityCleanupService {
    private static LOG_DIR = "/app/logs";
    private static LOG_PATH = "/app/logs/security.log";
    private static RETENTION_DAYS = 730;
    private static QUARTER_MONTHS = [0, 3, 6, 9];

    static async rotate() {
        const now = new Date();
        const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        const quarter = Math.floor(kyivNow.getMonth() / 3) + 1;
        const triggerKey = `security_cleanup_triggered:${kyivNow.getFullYear()}-Q${quarter}`;

        const alreadyTriggered = await redis.get(triggerKey);
        if (alreadyTriggered) return;

        logSecurityEvent({
            event: "logs.security.rotation.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "security-cleanup-service",
            operation: "rotate",
        });

        try {
            if (fs.existsSync(this.LOG_PATH)) {
                const stats = fs.statSync(this.LOG_PATH);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                const archiveName = `security-${kyivNow.getFullYear()}-Q${quarter}.log`;
                const archivePath = path.join(this.LOG_DIR, archiveName);

                fs.renameSync(this.LOG_PATH, archivePath);
                securityDestination.reopen();

                logSecurityEvent({
                    event: "logs.security.rotation.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "security-cleanup-service",
                    operation: "rotate",
                    safeContext: { archiveName, sizeMB, quarter, retentionDays: this.RETENTION_DAYS },
                });
            }

            this.purgeOldArchives();
            await redis.set(triggerKey, "true", "EX", 100 * 24 * 60 * 60);
        } catch (e: any) {
            logger.error({ err: e }, "Security log rotation failed");
            logSecurityEvent({
                event: "logs.security.rotation.completed",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "security-cleanup-service",
                operation: "rotate",
                safeContext: { quarter },
                error: e,
            });
        }
    }

    private static purgeOldArchives() {
        try {
            const files = fs.readdirSync(this.LOG_DIR);
            const cutoff = Date.now() - this.RETENTION_DAYS * 24 * 60 * 60 * 1000;

            for (const file of files) {
                if (!file.startsWith("security-") || !file.endsWith(".log")) continue;
                const filePath = path.join(this.LOG_DIR, file);
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(filePath);
                    logger.debug({ file }, "Old security log archive deleted");
                }
            }
        } catch (e: any) {
            logger.error({ err: e }, "Old security log archive purge failed");
        }
    }

    static async checkAndTrigger() {
        const now = new Date();
        const kyivDate = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));

        if (
            this.QUARTER_MONTHS.includes(kyivDate.getMonth()) &&
            kyivDate.getDate() === 1 &&
            kyivDate.getHours() === 5 &&
            kyivDate.getMinutes() === 5
        ) {
            await this.rotate();
        }
    }
}

export function startSecurityCleanupLoop() {
    logBusinessEvent({
        event: "logs.security.rotation_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "security-cleanup-service",
        operation: "startSecurityCleanupLoop",
    });
    setInterval(() => SecurityCleanupService.checkAndTrigger(), 60 * 1000);
}
