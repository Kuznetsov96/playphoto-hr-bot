import prisma from "../db/core.js";
import { TicketStatus } from "@prisma/client";

export class SupportRepository {
    async createTicket(data: { userId: string; issueText: string; status?: TicketStatus; isUrgent?: boolean; topicId?: number | null }) {
        return prisma.supportTicket.create({
            data: {
                userId: data.userId,
                issueText: data.issueText,
                status: data.status || "OPEN",
                isUrgent: data.isUrgent || false,
                topicId: data.topicId ?? null
            }
        });
    }

    async findTicketById(id: number) {
        return prisma.supportTicket.findUnique({
            where: { id },
            include: { 
                user: { include: { staffProfile: true } },
                assignedAdmin: true
            }
        });
    }

    async findActiveTicketByUser(userId: string) {
        return prisma.supportTicket.findFirst({
            where: {
                userId,
                status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] }
            }
        });
    }

    async updateTicket(id: number, data: any) {
        return prisma.supportTicket.update({
            where: { id },
            data
        });
    }

    async touchTicket(id: number) {
        return prisma.supportTicket.update({
            where: { id },
            data: { updatedAt: new Date() }
        });
    }

    async findTicketByTopicId(topicId: number) {
        return prisma.supportTicket.findFirst({
            where: { topicId },
            include: { user: true }
        });
    }

    async findTicketsByStatus(status: TicketStatus, limit: number = 50) {
        return prisma.supportTicket.findMany({
            where: { status },
            include: { user: { include: { staffProfile: true } } },
            orderBy: { createdAt: 'desc' },
            take: limit
        });
    }

    async countUrgent() {
        return prisma.supportTicket.count({
            where: {
                isUrgent: true,
                status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] }
            }
        });
    }

    async countByStatus(status: TicketStatus) {
        return prisma.supportTicket.count({
            where: { status }
        });
    }

    async findUrgentTickets() {
        return prisma.supportTicket.findMany({
            where: {
                isUrgent: true,
                status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] }
            },
            include: { user: { include: { staffProfile: true } } },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findStaleTickets(cutoff: Date) {
        return prisma.supportTicket.findMany({
            where: {
                status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] },
                updatedAt: { lte: cutoff }
            }
        });
    }

    async createOutgoingTopic(data: { chatId: bigint; topicId: number; staffName?: string; userId?: string }) {
        return prisma.outgoingTopic.create({ data });
    }

    async findActiveOutgoingTopicByUser(userId: string) {
        return prisma.outgoingTopic.findFirst({
            where: {
                userId,
                isClosed: false
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findOutgoingTopicByTopicId(topicId: number) {
        return prisma.outgoingTopic.findFirst({
            where: { topicId, isClosed: false },
            include: { user: true }
        });
    }
}

export const supportRepository = new SupportRepository();
