import pino from "pino";
import fs from "fs";
import path from "path";
import { REDACT_CONFIG } from "./logger.js";

// --- Audit Logger (separate Pino instance, writes only to audit.log) ---

const isProd = process.env.NODE_ENV === "production";
const logDir = isProd ? "/app/logs" : path.resolve("logs");
const auditLogPath = path.join(logDir, "audit.log");
const securityLogPath = path.join(logDir, "security.log");

if (!fs.existsSync(logDir)) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {
        console.error("❌ Failed to create audit log directory:", e);
    }
}

export const auditDestination = pino.destination({
    dest: auditLogPath,
    minLength: 4096,
    sync: false,
    append: true
});

export const securityDestination = pino.destination({
    dest: securityLogPath,
    minLength: 4096,
    sync: false,
    append: true
});

const auditLogger = pino(
    {
        level: "info",
        redact: REDACT_CONFIG,
        // No pino-pretty — always structured JSON for grep
    },
    pino.multistream([
        { stream: process.stdout },
        { stream: auditDestination },
    ])
);

const securityLogger = pino(
    {
        level: "info",
        redact: REDACT_CONFIG,
    },
    pino.multistream([
        { stream: process.stdout },
        { stream: securityDestination },
    ])
);

// --- Audit event types ---

export interface AuditParams {
    event: string;
    result: "started" | "success" | "failed";
    actorType: "candidate" | "staff" | "admin" | "system";
    actorId?: string | undefined;
    telegramId?: number | bigint | undefined;
    role?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | number | undefined;
    updateId?: number | undefined;
    context?: Record<string, unknown> | undefined;
    error?: string | undefined;
}

export interface SecurityAuditParams extends AuditParams {
    severity?: "info" | "warn" | "critical";
}

/**
 * Emit a structured audit event to audit.log.
 * Fire-and-forget — safe to call anywhere.
 */
export function audit(params: AuditParams): void {
    const { telegramId, ...rest } = params;
    auditLogger.info({
        audit: true,
        ...rest,
        telegramId: telegramId != null ? String(telegramId) : undefined,
    });
}

export function securityAudit(params: SecurityAuditParams): void {
    const { telegramId, severity = "warn", ...rest } = params;
    const payload = {
        audit: true,
        security: true,
        severity,
        ...rest,
        telegramId: telegramId != null ? String(telegramId) : undefined,
    };

    auditLogger.warn(payload);
    securityLogger.warn(payload);
}
