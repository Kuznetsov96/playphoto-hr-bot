import { timelineRepository } from "../repositories/timeline-repository.js";
import { CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";

export class TimelineService {
    /**
     * Record a transition in the recruitment funnel
     */
    async trackStatusChange(candidate: any, newStatus: CandidateStatus, author: "SYSTEM" | "ADMIN" = "SYSTEM", comment?: string) {
        try {
            const oldStatus = candidate.status;
            if (oldStatus === newStatus && !comment) return;

            const text = comment || `Зміна статусу: ${oldStatus} ➡️ ${newStatus}`;
            
            await timelineRepository.createEvent(
                candidate.userId,
                'STATUS_CHANGE',
                author,
                text,
                { oldStatus, newStatus, candidateId: candidate.id }
            );

            logger.info({ 
                candidateId: candidate.id, 
                telegramId: candidate.user?.telegramId?.toString(),
                oldStatus, 
                newStatus 
            }, `📈 [TIMELINE] Status Change: ${oldStatus} -> ${newStatus}`);
        } catch (e) {
            logger.error({ err: e, candidateId: candidate.id }, "Failed to track status change in timeline");
        }
    }

    /**
     * Record a specific step completion (e.g. Booking, Quiz, NDA)
     */
    async trackEvent(userId: string, text: string, metadata?: any, author: "USER" | "SYSTEM" | "ADMIN" = "SYSTEM") {
        try {
            await timelineRepository.createEvent(
                userId,
                'SYSTEM_EVENT',
                author,
                text,
                metadata
            );
            logger.info({ userId, event: text }, `📝 [TIMELINE] Event: ${text}`);
        } catch (e) {
            logger.error({ err: e, userId }, "Failed to track timeline event");
        }
    }
}

export const timelineService = new TimelineService();
