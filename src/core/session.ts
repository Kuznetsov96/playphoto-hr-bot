import type { Middleware } from "grammy";
import { redis } from "./redis.js";
import type { MyContext, SessionData } from "../types/context.js";
import logger from "./logger.js";

const REDIS_TTL_SEC = 86400; // 24 hours in Redis
const SESSION_CLEARED = Symbol("session-cleared");

export const bigIntReplacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;

function serialize(data: Partial<SessionData>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
            result[key] = JSON.stringify(value, bigIntReplacer);
        }
    }
    return result;
}

function deserialize(hash: Record<string, string>): SessionData {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(hash)) {
        try {
            result[key] = JSON.parse(value);
        } catch {
            result[key] = value;
        }
    }
    return result as unknown as SessionData;
}

function getDefaultSession(): SessionData {
    return {
        step: "idle",
        navStack: [],
        candidateData: {},
        messagesToDelete: [],
    };
}

function getRedisKey(ctx: MyContext): string | null {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const rawKey = userId !== undefined && chatId !== undefined
        ? `${chatId}:${userId}`
        : (chatId ?? userId)?.toString();
    return rawKey ? `session:${rawKey}` : null;
}

async function persistSession(redisKey: string, data: SessionData): Promise<void> {
    const serialized = serialize(data);

    try {
        // Replace the complete hash atomically. HSET alone leaves deleted fields behind,
        // which can resurrect an old flow after a process restart.
        const transaction = redis.multi();
        transaction.del(redisKey);
        if (Object.keys(serialized).length > 0) {
            transaction.hset(redisKey, serialized);
            transaction.expire(redisKey, REDIS_TTL_SEC);
        }
        const results = await transaction.exec();
        if (results === null || results.some(([error]) => error !== null)) {
            throw new Error("Redis session transaction failed");
        }
        logger.trace({ redisKey }, "💾 [SESSION] Persisted atomically");
    } catch (err) {
        logger.error({ err, redisKey }, "❌ [SESSION] Failed to persist session");
    }
}

export function lazySession(): Middleware<MyContext> {
    return async (ctx, next) => {
        const redisKey = getRedisKey(ctx);
        if (!redisKey) return next();

        let data: SessionData;
        try {
            const hash = await redis.hgetall(redisKey);
            data = Object.keys(hash).length > 0 ? deserialize(hash) : getDefaultSession();
            logger.trace({ redisKey }, "📂 [SESSION] Loaded from Redis");
        } catch (err) {
            logger.error({ err, redisKey }, "❌ [SESSION] Error reading from Redis, using default");
            data = getDefaultSession();
        }

        if (!data.candidateData) data.candidateData = {};
        if (!data.step) data.step = "idle";

        (ctx as MyContext & { [SESSION_CLEARED]?: boolean }).session = data;
        (ctx as MyContext & { [SESSION_CLEARED]?: boolean })[SESSION_CLEARED] = false;
        const initialState = JSON.stringify(data, bigIntReplacer);

        try {
            await next();
        } finally {
            const sessionContext = ctx as MyContext & { [SESSION_CLEARED]?: boolean };
            if (
                !sessionContext[SESSION_CLEARED] &&
                initialState !== JSON.stringify(sessionContext.session, bigIntReplacer)
            ) {
                await persistSession(redisKey, sessionContext.session);
            }
        }
    };
}

export async function clearSession(ctx: MyContext): Promise<void> {
    const redisKey = getRedisKey(ctx);
    if (!redisKey) return;

    ctx.session = getDefaultSession();
    (ctx as MyContext & { [SESSION_CLEARED]?: boolean })[SESSION_CLEARED] = true;
    try {
        await redis.del(redisKey);
    } catch (err) {
        logger.error({ err, redisKey }, "❌ [SESSION] Failed to delete session from Redis");
    }
}
