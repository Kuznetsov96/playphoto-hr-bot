import prisma from "../db/core.js";
import type { Prisma, SupportThreadStatus } from "@prisma/client";

export type LinkDirection = "IN" | "OUT" | "CONTEXT";

export type NewLink = {
    threadId: string;
    direction: LinkDirection;
    topicChatId: bigint;
    topicId?: number | null;
    topicMessageId: number;
    privateChatId?: bigint | null;
    privateMessageId?: number | null;
    contextText?: string | null;
};

export type LegacyConversation = {
    userId: string;
    topics: { chatId: bigint; topicId: number }[];
    ticketIds: number[];
    outgoingIds: number[];
    proofIds: string[];
    /** Стара розмова чекала відповіді підтримки: тікет не взяли або звіт чекає команду. */
    waiting: boolean;
};

const OPEN_PROOF_STATUSES = ["OPEN", "WAITING_FOR_STAFF", "WAITING_FOR_SUPPORT"] as const;

/** Постійні теми підтримки та пари повідомлень (spec 2026-10-08). */
export class SupportThreadRepository {
    findByUserId(userId: string) {
        return prisma.supportThread.findUnique({ where: { userId } });
    }

    findById(id: string) {
        return prisma.supportThread.findUnique({ where: { id } });
    }

    findByTopic(chatId: bigint, topicId: number) {
        return prisma.supportThread.findUnique({ where: { chatId_topicId: { chatId, topicId } } });
    }

    create(data: { userId: string; chatId: bigint; topicId: number; title: string }) {
        return prisma.supportThread.create({ data });
    }

    update(id: string, data: Prisma.SupportThreadUncheckedUpdateInput) {
        return prisma.supportThread.update({ where: { id }, data });
    }

    listByStatusNot(status: SupportThreadStatus) {
        return prisma.supportThread.findMany({ where: { status: { not: status } } });
    }

    listAll() {
        return prisma.supportThread.findMany();
    }

    /** Повторна обробка того самого оновлення не падає на унікальному індексі. */
    async addLink(link: NewLink) {
        await prisma.supportMessageLink.createMany({
            data: [{
                threadId: link.threadId,
                direction: link.direction,
                topicChatId: link.topicChatId,
                topicId: link.topicId ?? null,
                topicMessageId: link.topicMessageId,
                privateChatId: link.privateChatId ?? null,
                privateMessageId: link.privateMessageId ?? null,
                contextText: link.contextText ?? null,
            }],
            skipDuplicates: true,
        });
    }

    findLinkByTopicMessage(topicChatId: bigint, topicMessageId: number) {
        return prisma.supportMessageLink.findUnique({
            where: { topicChatId_topicMessageId: { topicChatId, topicMessageId } },
            include: { thread: true },
        });
    }

    findLinkByPrivateMessage(privateChatId: bigint, privateMessageId: number) {
        return prisma.supportMessageLink.findFirst({
            where: { privateChatId, privateMessageId },
            include: { thread: true },
            orderBy: { id: "asc" },
        });
    }

    /** Повідомлення фотографині після останньої відповіді підтримки — для покликаних. */
    listIncomingSince(threadId: string, since: Date | null, limit: number) {
        return prisma.supportMessageLink.findMany({
            where: { threadId, direction: "IN", ...(since ? { createdAt: { gt: since } } : {}) },
            orderBy: { id: "desc" },
            take: limit,
        });
    }

    deleteLinksOlderThan(date: Date) {
        return prisma.supportMessageLink.deleteMany({ where: { createdAt: { lt: date } } });
    }

    /**
     * Чия це стара тема: тікет, вихідна або тема задачі — без фільтра статусу,
     * бо після переходу вони всі закриті, а відповідь у них має дійти.
     */
    async findLegacyUserByTopic(chatId: bigint, topicId: number): Promise<string | null> {
        const ticket = await prisma.supportTicket.findFirst({ where: { topicId }, select: { userId: true }, orderBy: { id: "desc" } });
        if (ticket) return ticket.userId;

        const outgoing = await prisma.outgoingTopic.findFirst({ where: { chatId, topicId, userId: { not: null } }, select: { userId: true }, orderBy: { id: "desc" } });
        if (outgoing?.userId) return outgoing.userId;

        const proof = await prisma.taskProofSubmission.findFirst({
            where: { supportChatId: chatId, supportTopicId: topicId },
            select: { staff: { select: { userId: true } } },
        });
        return proof?.staff.userId ?? null;
    }

    async listLegacyActive(supportChatId: bigint): Promise<LegacyConversation[]> {
        const [tickets, outgoing, proofs] = await Promise.all([
            prisma.supportTicket.findMany({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true, userId: true, topicId: true, status: true }, orderBy: { id: "asc" } }),
            prisma.outgoingTopic.findMany({ where: { isClosed: false }, select: { id: true, userId: true, topicId: true, chatId: true }, orderBy: { id: "asc" } }),
            prisma.taskProofSubmission.findMany({
                where: { supportTopicStatus: { in: [...OPEN_PROOF_STATUSES] }, supportTopicId: { not: null } },
                select: { id: true, supportTopicId: true, supportChatId: true, supportTopicStatus: true, staff: { select: { userId: true } } },
                orderBy: { createdAt: "asc" },
            }),
        ]);

        const byUser = new Map<string, LegacyConversation>();
        const entry = (userId: string) => {
            let row = byUser.get(userId);
            if (!row) {
                row = { userId, topics: [], ticketIds: [], outgoingIds: [], proofIds: [], waiting: false };
                byUser.set(userId, row);
            }
            return row;
        };

        for (const ticket of tickets) {
            const row = entry(ticket.userId);
            row.ticketIds.push(ticket.id);
            if (ticket.status === "OPEN") row.waiting = true;
            if (ticket.topicId) row.topics.push({ chatId: supportChatId, topicId: ticket.topicId });
        }
        for (const topic of outgoing) {
            if (!topic.userId) continue;
            const row = entry(topic.userId);
            row.outgoingIds.push(topic.id);
            row.topics.push({ chatId: topic.chatId, topicId: topic.topicId });
        }
        for (const proof of proofs) {
            const row = entry(proof.staff.userId);
            row.proofIds.push(proof.id);
            if (proof.supportTopicStatus === "OPEN" || proof.supportTopicStatus === "WAITING_FOR_SUPPORT") row.waiting = true;
            if (proof.supportTopicId && proof.supportChatId) row.topics.push({ chatId: proof.supportChatId, topicId: proof.supportTopicId });
        }
        return [...byUser.values()];
    }

    async closeLegacy(ids: { ticketIds: number[]; outgoingIds: number[]; proofIds: string[] }) {
        const now = new Date();
        await Promise.all([
            ids.ticketIds.length ? prisma.supportTicket.updateMany({ where: { id: { in: ids.ticketIds } }, data: { status: "CLOSED" } }) : null,
            ids.outgoingIds.length ? prisma.outgoingTopic.updateMany({ where: { id: { in: ids.outgoingIds } }, data: { isClosed: true } }) : null,
            ids.proofIds.length ? prisma.taskProofSubmission.updateMany({ where: { id: { in: ids.proofIds } }, data: { supportTopicStatus: "CLOSED", supportTopicClosedAt: now } }) : null,
        ]);
    }

    /** Прізвища, що повторюються серед активних і тих, у кого вже є тема. */
    async listCollidingSurnames(): Promise<Set<string>> {
        const profiles = await prisma.staffProfile.findMany({
            where: { OR: [{ isActive: true }, { user: { supportThread: { isNot: null } } }] },
            select: { fullName: true },
        });
        const counts = new Map<string, number>();
        for (const profile of profiles) {
            const surname = profile.fullName.trim().split(/\s+/)[0] ?? "";
            if (surname) counts.set(surname, (counts.get(surname) ?? 0) + 1);
        }
        return new Set([...counts].filter(([, count]) => count > 1).map(([surname]) => surname));
    }
}

export const supportThreadRepository = new SupportThreadRepository();
