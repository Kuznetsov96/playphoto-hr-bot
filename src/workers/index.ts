import { Worker } from 'bullmq';
import { QUEUES } from '../core/queue.js';
import { redis } from '../core/redis.js';
import logger from '../core/logger.js';
import { broadcastService } from '../services/broadcast.js';
import { Bot } from 'grammy';
import process from 'process';
import { sendDailyIncomeReport, sendMorningAuditReport } from '../services/finance-report.js';
import { preferencesService } from '../services/preferences-service.js';

const connection = redis;

export const startWorkers = () => {
    logger.info('👷 Starting workers...');

    const defaultWorker = new Worker(QUEUES.DEFAULT, async job => {
        logger.info({ jobId: job.id, name: job.name }, 'Processing job');
        // TODO: Implement job processing logic
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
        const botApi = new Bot(process.env.BOT_TOKEN!).api; // Helper
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

    logger.info(`✅ ${workers.length} workers started`);
};
