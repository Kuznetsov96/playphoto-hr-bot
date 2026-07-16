import { beforeEach, describe, expect, it, vi } from "vitest";

const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();

vi.mock("../../repositories/support-repository.js", () => ({
    supportRepository: {
        findActiveTicketByUser,
        findActiveOutgoingTopicByUser,
    },
}));

describe("SupportConversationService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses an active user ticket as the canonical route", async () => {
        const ticket = { id: 857, topicId: 33298, status: "IN_PROGRESS" };
        findActiveTicketByUser.mockResolvedValue(ticket);

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveActive("user-1");

        expect(route).toEqual({
            kind: "ticket",
            id: 857,
            topicId: 33298,
            ticket,
        });
        expect(findActiveOutgoingTopicByUser).not.toHaveBeenCalled();
    });

    it("falls back to the active admin-created outgoing topic", async () => {
        const outgoingTopic = { id: 571, topicId: 33713, isClosed: false };
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(outgoingTopic);

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveActive("user-1");

        expect(route).toEqual({
            kind: "outgoing",
            id: 571,
            topicId: 33713,
            outgoingTopic,
        });
    });

    it("does not create an outgoing topic when a ticket already exists", async () => {
        const ticket = { id: 857, topicId: 33298, status: "IN_PROGRESS" };
        const createOutgoing = vi.fn();
        findActiveTicketByUser.mockResolvedValue(ticket);

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveOrCreateOutgoing("user-1", createOutgoing);

        expect(route.kind).toBe("ticket");
        expect(route.topicId).toBe(33298);
        expect(createOutgoing).not.toHaveBeenCalled();
    });

    it("creates one outgoing topic only when no conversation exists", async () => {
        const outgoingTopic = { id: 600, topicId: 34000, isClosed: false };
        const createOutgoing = vi.fn().mockResolvedValue(outgoingTopic);
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveOrCreateOutgoing("user-1", createOutgoing);

        expect(route).toEqual({
            kind: "outgoing",
            id: 600,
            topicId: 34000,
            outgoingTopic,
        });
        expect(createOutgoing).toHaveBeenCalledOnce();
    });
});
