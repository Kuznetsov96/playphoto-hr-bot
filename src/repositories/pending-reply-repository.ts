import prisma from "../db/core.js";
import { Prisma } from "@prisma/client";
import type { PendingReply, User, StaffProfile } from "@prisma/client";

export type PendingReplyWithRelations = PendingReply & {
    user: User & { staffProfile: StaffProfile | null };
};

export class PendingReplyRepository {
    async create(data: Prisma.PendingReplyCreateInput) {
        return prisma.pendingReply.create({ data, include: { user: { include: { staffProfile: true } } } }) as unknown as Promise<PendingReplyWithRelations>;
    }

    async findFirst(where: Prisma.PendingReplyWhereInput) {
        return prisma.pendingReply.findFirst({ where, include: { user: { include: { staffProfile: true } } } }) as unknown as Promise<PendingReplyWithRelations | null>;
    }

    async update(id: number, data: Prisma.PendingReplyUpdateInput) {
        return prisma.pendingReply.update({
            where: { id },
            data
        });
    }

    async updateMany(where: Prisma.PendingReplyWhereInput, data: Prisma.PendingReplyUpdateManyMutationInput) {
        return prisma.pendingReply.updateMany({ where, data });
    }

    async deleteMany(where: Prisma.PendingReplyWhereInput) {
        return prisma.pendingReply.deleteMany({ where });
    }

    async findMany(where: Prisma.PendingReplyWhereInput, include?: Prisma.PendingReplyInclude): Promise<PendingReplyWithRelations[]> {
        return prisma.pendingReply.findMany({
            where,
            ...(include ? { include } : { include: { user: { include: { staffProfile: true } } } })
        }) as unknown as Promise<PendingReplyWithRelations[]>;
    }
}

export const pendingReplyRepository = new PendingReplyRepository();
