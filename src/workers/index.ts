import { Worker } from 'bullmq';
import { QUEUES } from '../core/queue.js';
import { redis } from '../core/redis.js';
import logger from '../core/logger.js';
import { broadcastService } from '../services/broadcast.js';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import process from 'process';
import { sendDailyIncomeReport } from '../services/finance-report.js';
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
        if (job.name === 'recruiting-mirror-push') {
            // Ошибка пробрасывается — ретраями (attempts/backoff из джоба)
            // управляет BullMQ; финально упавший джоб остаётся в failed.
            const { processCandidateMirrorPush } = await import('../services/recruiting-mirror/push-service.js');
            await processCandidateMirrorPush(job.data.candidateId);
        }
        if (job.name === 'announcement-sync') {
            // Ошибка пробрасывается — ретраи (attempts/backoff) ведёт BullMQ.
            const { processAnnouncementSync } = await import('../services/announcement-sync.js');
            await processAnnouncementSync(job.data.broadcastId);
        }
    }, { connection });

    const broadcastWorker = new Worker(QUEUES.BROADCAST, async job => {
        logger.info({ jobId: job.id }, 'Processing broadcast');
        try {
            // autoRetry, как в core/bot.ts: 429 на большой рассылке ждёт retry_after, а не валит доставки.
            const broadcastBot = new Bot(process.env.BOT_TOKEN!);
            broadcastBot.api.config.use(autoRetry());
            await broadcastService.processBroadcast(job.data, broadcastBot.api);
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
            }
            logger.info({ jobId: job.id }, '✅ Report job done');
        } catch (e) {
            logger.error({ err: e }, '❌ Report job failed');
            throw e;
        }
    }, { connection });

    const workers = [defaultWorker, broadcastWorker, reportsWorker];

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
