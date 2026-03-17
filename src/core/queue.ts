import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const QUEUES = {
    DEFAULT: 'default',
    BROADCAST: 'broadcast',
    REPORTS: 'reports',
    PREFERENCES: 'preferences'
} as const;

export const defaultQueue = new Queue(QUEUES.DEFAULT, { connection: redis });
export const broadcastQueue = new Queue(QUEUES.BROADCAST, { connection: redis });
export const reportsQueue = new Queue(QUEUES.REPORTS, { connection: redis });
export const preferencesQueue = new Queue(QUEUES.PREFERENCES, { connection: redis });

export const queues = [defaultQueue, broadcastQueue, reportsQueue, preferencesQueue];
