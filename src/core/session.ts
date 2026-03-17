import type { Middleware } from "grammy";
import { redis } from "./redis.js";
import type { MyContext, SessionData } from "../types/context.js";
import logger from "./logger.js";

interface CacheEntry {
    data: SessionData;
    dirty: boolean;
    lastAccessed: number;
    flushTimer?: NodeJS.Timeout | null;
}

const sessionCache = new Map<string, CacheEntry>();
const RAM_TTL_MS = 1000 * 60 * 30; // 30 minutes in RAM
const REDIS_TTL_SEC = 86400; // 24 hours in Redis
const DEBOUNCE_MS = 500; // 500ms debounce for Redis writes

export const bigIntReplacer = (key: string, value: any) =>
    typeof value === 'bigint' ? value.toString() : value;

function serialize(data: Partial<SessionData>): Record<string, string> {
    const res: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) {
            res[k] = JSON.stringify(v, bigIntReplacer);
        }
    }
    return res;
}

function deserialize(hash: Record<string, string>): SessionData {
    const res: any = {};
    for (const [k, v] of Object.entries(hash)) {
        try {
            res[k] = JSON.parse(v);
        } catch {
            res[k] = v; // Fallback
        }
    }
    return res as SessionData;
}

function getDefaultSession(): SessionData {
    return {
        step: "idle",
        navStack: [],
        candidateData: {},
        messagesToDelete: []
    };
}

async function flushToRedis(key: string, entry: CacheEntry) {
    if (!entry.dirty) return;

    const serialized = serialize(entry.data);
    if (Object.keys(serialized).length === 0) return;

    try {
        const pipeline = redis.pipeline();
        pipeline.hset(key, serialized);
        pipeline.expire(key, REDIS_TTL_SEC);
        await pipeline.exec();
        entry.dirty = false;
        logger.trace(`💾 [SESSION] Flushed ${key} to Redis Hash`);
    } catch (err) {
        logger.error({ err, key }, "❌ [SESSION] Failed to flush session to Redis");
    }
}

function scheduleFlush(key: string, entry: CacheEntry) {
    entry.dirty = true;
    if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
    }
    entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        flushToRedis(key, entry).catch(() => { });
    }, DEBOUNCE_MS);
}

// Memory cleanup interval
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessionCache.entries()) {
        if (now - entry.lastAccessed > RAM_TTL_MS) {
            if (entry.dirty) {
                flushToRedis(key, entry).finally(() => sessionCache.delete(key));
            } else {
                sessionCache.delete(key);
            }
        }
    }
}, 1000 * 60 * 5); // Clean every 5 min

export function lazySession(): Middleware<MyContext> {
    return async (ctx, next) => {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;

        // We use chat ID as session key if available, fallback to user ID
        const rawKey = chatId ?? userId;
        if (!rawKey) {
            // No session possible for this update
            return next();
        }

        const redisKey = `session:${rawKey}`;
        let entry = sessionCache.get(redisKey);

        if (!entry) {
            try {
                const hash = await redis.hgetall(redisKey);
                let data: SessionData;
                if (Object.keys(hash).length > 0) {
                    data = deserialize(hash);
                } else {
                    data = getDefaultSession();
                }

                // Provide defaults if fields missing
                if (!data.candidateData) data.candidateData = {};
                if (!data.step) data.step = "idle";

                entry = { data, dirty: false, lastAccessed: Date.now() };
                sessionCache.set(redisKey, entry);
                logger.trace({ redisKey }, "📂 [SESSION] Loaded from Redis to RAM");
            } catch (err) {
                logger.error({ err, redisKey }, "❌ [SESSION] Error reading from Redis, using default");
                entry = { data: getDefaultSession(), dirty: true, lastAccessed: Date.now() };
                sessionCache.set(redisKey, entry);
            }
        } else {
            entry.lastAccessed = Date.now();
        }

        // Expose session on ctx
        (ctx as any).session = entry.data;

        const initialHashStr = JSON.stringify(entry.data, bigIntReplacer);

        try {
            await next();
        } finally {
            // Check if mutated
            if (initialHashStr !== JSON.stringify((ctx as any).session, bigIntReplacer)) {
                entry.data = (ctx as any).session;
                scheduleFlush(redisKey, entry);
            }
        }
    };
}

export async function clearSession(ctx: MyContext) {
    const rawKey = ctx.chat?.id ?? ctx.from?.id;
    if (!rawKey) return;
    const redisKey = `session:${rawKey}`;

    const entry = sessionCache.get(redisKey);
    if (entry?.flushTimer) clearTimeout(entry.flushTimer);
    sessionCache.delete(redisKey);

    ctx.session = getDefaultSession();
    try {
        await redis.del(redisKey);
    } catch (err) {
        logger.error({ err, redisKey }, "❌ [SESSION] Failed to delete session from Redis");
    }
}
