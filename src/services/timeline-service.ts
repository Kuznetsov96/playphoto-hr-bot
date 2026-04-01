import { timelineRepository } from "../repositories/timeline-repository.js";
import { CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";

export class TimelineService {
    /**
     * Record a transition in the recruitment funnel
     */
    async trackStatusChange(candidate: any, oldStatus: CandidateStatus, newStatus: CandidateStatus, author: "SYSTEM" | "ADMIN" = "SYSTEM", comment?: string) {
        try {
            if (oldStatus === newStatus && !comment) return;

            const text = comment || `Зміна статусу: ${oldStatus} ➡️ ${newStatus}`;
            
            await timelineRepository.createEvent(
                candidate.userId,
                'STATUS_CHANGE',
                author,
                text,
                { oldStatus, newStatus, candidateId: candidate.id }
            );

            logBusinessEvent({
                event: "candidate.status.changed",
                candidateId: candidate.id,
                telegramId: candidate.user?.telegramId,
                actorType: author === "ADMIN" ? "admin" : "system",
                actorRole: author === "ADMIN" ? "admin" : "system",
                result: "success",
                module: "timeline-service",
                operation: "trackStatusChange",
                safeContext: {
                    oldStatus,
                    newStatus,
                },
            });
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
            logger.debug({ userId, eventType: metadata?.event || null }, "Timeline event recorded");
        } catch (e) {
            logger.error({ err: e, userId }, "Failed to track timeline event");
        }
    }
}

export const timelineService = new TimelineService();
