import { Worker } from 'bullmq';
import { QUEUES } from '../core/queue.js';
import { redis } from '../core/redis.js';
import logger from '../core/logger.js';
import { broadcastService } from '../services/broadcast.js';
import { Bot } from 'grammy';
import process from 'process';
import { sendDailyIncomeReport, sendMorningAuditReport } from '../services/finance-report.js';
import { preferencesService } from '../services/preferences-service.js';
import { logBusinessEvent } from '../core/log-events.js';

const connection = redis;

export const startWorkers = () => {
    logBusinessEvent({
        event: "workers.registry.started",
        actorType: "system",
        actorRole: "system",
        result: "started",
        module: "workers",
        operation: "startWorkers",
    });

    const defaultWorker = new Worker(QUEUES.DEFAULT, async job => {
        logger.info({ jobId: job.id, name: job.name }, 'Processing job');
        if (job.name === 'replacement-dispatch-wave') {
            const bot = new Bot(process.env.BOT_TOKEN!);
            const { replacementService } = await import('../services/replacement-service.js');
            await replacementService.dispatchNextWave(bot.api, job.data.requestId);
        }
    }, { connection });

    const broadcastWorker = new Worker(QUEUES.BROADCAST, async job => {
        logger.info({ jobId: job.id }, 'Processing broadcast');
        try {
            await broadcastService.processBroadcast(job.data, new Bot(process.env.BOT_TOKEN!).api);
            logger.info({ jobId: job.id }, '✅ Broadcast job done');
        } catch (e) {
            logger.error({ err: e }, '❌ Broadcast job failed');
            throw e;
        }
    }, { connection });


    const reportsWorker = new Worker(QUEUES.REPORTS, async job => {
        // We need a full bot instance for some methods if they rely on bot.api, but services mostly take bot instance.
        // Actually sendDailyIncomeReport takes (bot: Bot<MyContext>).
        // Constructing a new Bot instance is cheap.
        const bot = new Bot(process.env.BOT_TOKEN!);

        logger.info({ jobId: job.id, name: job.name }, 'Processing report');

        try {
            if (job.name === 'send-daily-income') {
                await sendDailyIncomeReport(bot as any, job.data.chatId);
            } else if (job.name === 'send-morning-audit') {
                await sendMorningAuditReport(bot as any, new Date(job.data.dateIso));
            }
            logger.info({ jobId: job.id }, '✅ Report job done');
        } catch (e) {
            logger.error({ err: e }, '❌ Report job failed');
            throw e;
        }
    }, { connection });

    const preferencesWorker = new Worker(QUEUES.PREFERENCES, async job => {
        logger.info({ jobId: job.id, name: job.name }, 'Processing preference save');
        try {
            if (job.name === 'save-pref') {
                await preferencesService.savePreference(job.data);
            }
            logger.info({ jobId: job.id }, '✅ Preference job done');
        } catch (e) {
            logger.error({ err: e }, '❌ Preference job failed');
            throw e;
        }
    }, { connection });

    const workers = [defaultWorker, broadcastWorker, reportsWorker, preferencesWorker];

    workers.forEach(worker => {
        worker.on('completed', job => {
            logger.info({ jobId: job.id }, '✅ Job completed');
        });

        worker.on('failed', (job, err) => {
            logger.error({ jobId: job?.id, err }, '❌ Job failed');
        });
    });

    logBusinessEvent({
        event: "workers.registry.completed",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "workers",
        operation: "startWorkers",
        safeContext: { workerCount: workers.length },
    });

    return workers;
};
