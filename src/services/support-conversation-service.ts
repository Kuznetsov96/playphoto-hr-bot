import { supportRepository } from "../repositories/support-repository.js";

type ActiveTicket = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveTicketByUser>>>;
type ActiveOutgoingTopic = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveOutgoingTopicByUser>>>;

export type ActiveSupportConversation =
    | { kind: "ticket"; id: number; topicId: number | null; ticket: ActiveTicket }
    | { kind: "outgoing"; id: number; topicId: number; outgoingTopic: ActiveOutgoingTopic };

export class SupportConversationService {
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
        const active = await this.resolveActive(userId);
        if (active) return active;

        const outgoingTopic = await createOutgoing();
        return {
            kind: "outgoing",
            id: outgoingTopic.id,
            topicId: outgoingTopic.topicId,
            outgoingTopic,
        };
    }
}

export const supportConversationService = new SupportConversationService();
