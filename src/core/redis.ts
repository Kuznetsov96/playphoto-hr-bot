import { Redis } from 'ioredis';
import logger from './logger.js';
import { logBusinessEvent } from "./log-events.js";

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, {
    db: 0, // Explicitly use DB 0 to prevent NaN issues
    maxRetriesPerRequest: null, // Required for BullMQ
    connectTimeout: 10000, // 10 seconds timeout
    lazyConnect: true,
    retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

redis.on('connect', () => {
    logBusinessEvent({
        event: "infra.redis.connected",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "redis",
        operation: "connect",
    });
});

redis.on('error', (err: Error) => {
    logger.error({ err }, '❌ Redis connection error');
});

redis.on('ready', () => {
    logBusinessEvent({
        event: "infra.redis.ready",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "redis",
        operation: "ready",
    });
});

export default redis;
