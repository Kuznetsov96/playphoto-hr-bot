import prisma from "../db/core.js";

export type TimelineEventType = 'MESSAGE' | 'SYSTEM_EVENT' | 'STATUS_CHANGE';
export type TimelineEventAuthor = 'USER' | 'ADMIN' | 'SYSTEM';

export class TimelineRepository {
    async createEvent(
        userId: string,
        type: TimelineEventType,
        author: TimelineEventAuthor,
        text: string | null,
        metadata?: any
    ) {
        return prisma.userTimelineEvent.create({
            data: {
                userId,
                type,
                author,
                text,
                metadata: metadata ? JSON.stringify(metadata) : null
            }
        });
    }

    async getHistory(userId: string) {
        return prisma.userTimelineEvent.findMany({
            where: { userId },
            orderBy: { createdAt: 'asc' }
        });
    }

    async getLatestEvent(userId: string) {
        return prisma.userTimelineEvent.findFirst({
            where: { userId },
            orderBy: { createdAt: 'desc' }
        });
    }
}

export const timelineRepository = new TimelineRepository();
