import { Prisma } from "@prisma/client";
import prisma from "../db/core.js";

export class MessageRepository {
    async create(data: Prisma.MessageCreateInput) {
        return prisma.message.create({
            data
        });
    }

    async findByCandidateId(candidateId: string) {
        return prisma.message.findMany({
            where: { candidateId },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findByCandidateIdAndScope(candidateId: string, scope: string) {
        return prisma.message.findMany({
            where: { candidateId, scope },
            orderBy: { createdAt: 'desc' }
        });
    }

    async findLatestForCandidate(candidateId: string) {
        return prisma.message.findFirst({
            where: { candidateId },
            orderBy: { createdAt: 'desc' }
        });
    }
}

export const messageRepository = new MessageRepository();
