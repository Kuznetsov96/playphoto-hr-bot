import { supportRepository } from "../repositories/support-repository.js";
import { redis } from "../core/redis.js";
import logger from "../core/logger.js";

type ActiveTicket = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveTicketByUser>>>;
type ActiveOutgoingTopic = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveOutgoingTopicByUser>>>;

export type ActiveSupportConversation =
    | { kind: "ticket"; id: number; topicId: number | null; ticket: ActiveTicket }
    | { kind: "outgoing"; id: number; topicId: number; outgoingTopic: ActiveOutgoingTopic };

export class SupportConversationService {
    async withUserLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
        const lockKey = `support:conversation-lock:${userId}`;
        const token = `${process.pid}:${Date.now()}:${Math.random()}`;
        const acquired = await redis.set(lockKey, token, "PX", 30_000, "NX");
        if (acquired !== "OK") {
            throw new Error(`Support conversation for ${userId} is being created by another process`);
        }

        try {
            return await operation();
        } finally {
            await redis.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                lockKey,
                token,
            ).catch(error => logger.error({ err: error, userId }, "Failed to release support conversation lock"));
        }
    }

    /**
     * A user has one canonical support route. User-created tickets take
     * precedence over admin-created outgoing topics because they represent an
     * already active request owned by the user.
     */
    async resolveActive(userId: string): Promise<ActiveSupportConversation | null> {
        const ticket = await supportRepository.findActiveTicketByUser(userId);
        if (ticket) {
            return {
                kind: "ticket",
                id: ticket.id,
                topicId: ticket.topicId,
                ticket,
            };
        }

        const outgoingTopic = await supportRepository.findActiveOutgoingTopicByUser(userId);
        if (!outgoingTopic) return null;

        return {
            kind: "outgoing",
            id: outgoingTopic.id,
            topicId: outgoingTopic.topicId,
            outgoingTopic,
        };
    }

    async resolveOrCreateOutgoing(
        userId: string,
        createOutgoing: () => Promise<ActiveOutgoingTopic>
    ): Promise<ActiveSupportConversation> {
        return this.withUserLock(userId, async () => {
            const active = await this.resolveActive(userId);
            if (active) return active;

            const outgoingTopic = await createOutgoing();
            return {
                kind: "outgoing" as const,
                id: outgoingTopic.id,
                topicId: outgoingTopic.topicId,
                outgoingTopic,
            };
        });
    }
}

export const supportConversationService = new SupportConversationService();
