import { beforeEach, describe, expect, it, vi } from "vitest";

const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();
const redisSet = vi.fn();
const redisEval = vi.fn();

vi.mock("../../repositories/support-repository.js", () => ({
    supportRepository: {
        findActiveTicketByUser,
        findActiveOutgoingTopicByUser,
    },
}));
vi.mock("../../core/redis.js", () => ({ redis: { set: redisSet, eval: redisEval } }));
vi.mock("../../core/logger.js", () => ({ default: { error: vi.fn() } }));

describe("SupportConversationService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisSet.mockResolvedValue("OK");
        redisEval.mockResolvedValue(1);
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
        expect(route.created).toBe(false);
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
            created: true,
        });
        expect(createOutgoing).toHaveBeenCalledOnce();
    });

    it("marks a reused conversation as not created", async () => {
        // Адмінський екран за цим прапорцем відрізняє «створено нову гілку»
        // від «дописано в стару»: раніше він рапортував успіх однаково, і
        // повідомлення тихо лягало в тему, яку ніхто не читає.
        const outgoingTopic = { id: 601, topicId: 34001, isClosed: false };
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(outgoingTopic);
        const createOutgoing = vi.fn();

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveOrCreateOutgoing("user-1", createOutgoing);

        expect(route.created).toBe(false);
        expect(createOutgoing).not.toHaveBeenCalled();
    });

    it("waits for a briefly held lock instead of failing at once", async () => {
        // Лок беруть на 30 секунд, а віддають у finally. Раніше зайнятий лок
        // валив відправку миттєво: подвійний тап або паралельний воркер —
        // і повідомлення йшло повз підтримку, бо помилку ковтав catch вище.
        const outgoingTopic = { id: 602, topicId: 34002, isClosed: false };
        redisSet.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
        const createOutgoing = vi.fn().mockResolvedValue(outgoingTopic);

        const { SupportConversationService } = await import("../support-conversation-service.js");
        const route = await new SupportConversationService().resolveOrCreateOutgoing("user-1", createOutgoing);

        expect(route.topicId).toBe(34002);
        expect(createOutgoing).toHaveBeenCalledOnce();
        expect(redisSet).toHaveBeenCalledTimes(2);
    });

    it("still gives up when the lock is held for the whole wait window", async () => {
        redisSet.mockResolvedValue(null);
        const createOutgoing = vi.fn();
        const { SupportConversationService } = await import("../support-conversation-service.js");

        await expect(
            new SupportConversationService().resolveOrCreateOutgoing("user-1", createOutgoing),
        ).rejects.toThrow("another process");

        expect(createOutgoing).not.toHaveBeenCalled();
    });
});
