
import { chatLogRepository } from '../repositories/chat-log-repository.js';
import prisma from '../db/core.js';
import logger from '../core/logger.js';

async function main() {
    const DAYS_TO_KEEP = 90; // 3 months
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAYS_TO_KEEP);

    logger.info({ cutoff }, '🧹 Starting ChatLog cleanup...');

    try {
        const result = await chatLogRepository.deleteOldLogs(cutoff);
        logger.info({ deletedCount: result.count }, '✅ ChatLog cleanup completed');
    } catch (error) {
        logger.error({ err: error }, '❌ ChatLog cleanup failed');
    } finally {
        await prisma.$disconnect();
    }
}

main();
