import prisma from "../db/core.js";
import { LeadPlatform, LeadStatus, Prisma } from "@prisma/client";

export class LeadRepository {
    async findById(id: string) {
        return prisma.lead.findUnique({
            where: { id },
            include: { messages: { orderBy: { createdAt: "asc" } }, candidate: true }
        });
    }

    async findByExternalId(externalId: string, platform: LeadPlatform) {
        return prisma.lead.findUnique({
            where: { externalId },
            include: { messages: { orderBy: { createdAt: "asc" } } }
        });
    }

    async findByPlatformThreadId(threadId: string) {
        return prisma.lead.findUnique({
            where: { platformThreadId: threadId },
            include: { messages: { orderBy: { createdAt: "asc" } } }
        });
    }

    async findByTopicId(topicId: number) {
        return prisma.lead.findFirst({
            where: { topicId },
            include: { messages: { orderBy: { createdAt: "asc" } } }
        });
    }

    async create(data: Prisma.LeadCreateInput) {
        return prisma.lead.create({ data });
    }

    async update(id: string, data: Prisma.LeadUpdateInput) {
        return prisma.lead.update({ where: { id }, data });
    }

    async addMessage(leadId: string, direction: "IN" | "OUT", text?: string, mediaUrl?: string) {
        return prisma.$transaction([
            prisma.leadMessage.create({
                data: { 
                    leadId, 
                    direction, 
                    text: text ?? null, 
                    mediaUrl: mediaUrl ?? null 
                }
            }),
            prisma.lead.update({
                where: { id: leadId },
                data: { lastMessage: text || "[Media]", updatedAt: new Date() }
            })
        ]);
    }

    async findNewLeads() {
        return prisma.lead.findMany({
            where: { status: LeadStatus.NEW },
            orderBy: { updatedAt: "desc" }
        });
    }

    async countNewLeads() {
        return prisma.lead.count({
            where: { status: LeadStatus.NEW }
        });
    }
}

export const leadRepository = new LeadRepository();
