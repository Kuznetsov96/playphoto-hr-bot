import logger from "./logger.js";
import { audit, securityAudit } from "./audit-logger.js";

export interface LogEventParams {
    event: string;
    level?: "debug" | "info" | "warn" | "error" | undefined;
    correlationId?: string | undefined;
    updateId?: number | undefined;
    telegramId?: string | number | bigint | undefined;
    userId?: string | undefined;
    candidateId?: string | undefined;
    actorType?: "candidate" | "staff" | "admin" | "system" | undefined;
    actorId?: string | undefined;
    actorRole?: string | undefined;
    stage?: string | undefined;
    result?: string | undefined;
    reasonCode?: string | undefined;
    module?: string | undefined;
    operation?: string | undefined;
    durationMs?: number | undefined;
    safeContext?: Record<string, unknown> | undefined;
    error?: unknown;
}

function normalizeBase(params: LogEventParams) {
    return {
        event: params.event,
        correlation_id: params.correlationId,
        update_id: params.updateId,
        telegram_id: params.telegramId != null ? String(params.telegramId) : undefined,
        user_id: params.userId,
        candidate_id: params.candidateId,
        actor_type: params.actorType,
        actor_id: params.actorId,
        actor_role: params.actorRole,
        stage: params.stage,
        result: params.result,
        reason_code: params.reasonCode,
        module: params.module,
        operation: params.operation,
        duration_ms: params.durationMs,
        safe_context: params.safeContext,
        err: params.error,
    };
}

export function logBusinessEvent(params: LogEventParams, message?: string) {
    const level = params.level || "info";
    logger[level](normalizeBase(params), message || params.event);
}

export function logSecurityEvent(params: LogEventParams, message?: string) {
    const normalized = normalizeBase(params);
    logger.warn(normalized, message || params.event);
    securityAudit({
        event: params.event,
        result: (params.result as any) || "failed",
        actorType: params.actorType || "system",
        actorId: params.actorId,
        telegramId: params.telegramId as any,
        role: params.actorRole,
        entityType: params.module || "security",
        entityId: params.candidateId || params.userId,
        context: params.safeContext,
        error: params.error instanceof Error ? params.error.message : params.error ? String(params.error) : undefined,
    });
}

export function logAuditEvent(params: LogEventParams) {
    audit({
        event: params.event,
        result: (params.result as any) || "success",
        actorType: params.actorType || "system",
        actorId: params.actorId,
        telegramId: params.telegramId as any,
        role: params.actorRole,
        entityType: params.module || "business",
        entityId: params.candidateId || params.userId,
        updateId: params.updateId,
        context: {
            stage: params.stage,
            reasonCode: params.reasonCode,
            ...params.safeContext,
        },
        error: params.error instanceof Error ? params.error.message : params.error ? String(params.error) : undefined,
    });
}
