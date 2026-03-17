import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import prisma from "../db/core.js";

export class UserRepository {
    async findByTelegramId(telegramId: bigint): Promise<User | null> {
        return prisma.user.findUnique({
            where: { telegramId }
        });
    }

    async findById(id: string): Promise<User | null> {
        return prisma.user.findUnique({
            where: { id }
        });
    }

    async findWithStaffProfileById(id: string) {
        return prisma.user.findUnique({
            where: { id },
            include: {
                staffProfile: {
                    include: {
                        location: true
                    }
                }
            }
        });
    }

    async create(data: Prisma.UserCreateInput): Promise<User> {
        return prisma.user.create({
            data
        });
    }

    async update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
        return prisma.user.update({
            where: { id },
            data
        });
    }

    async findWithStaffProfileByTelegramId(telegramId: bigint) {
        return prisma.user.findUnique({
            where: { telegramId },
            include: {
                staffProfile: {
                    include: {
                        location: true
                    }
                },
                candidate: {
                    include: {
                        location: true
                    }
                }
            }
        });
    }

    async findWithProfilesByTelegramId(telegramId: bigint) {
        if (!telegramId) return null;
        return prisma.user.findUnique({
            where: { telegramId },
            include: {
                staffProfile: { include: { location: true } },
                candidate: { include: { location: true } }
            }
        });
    }

    async findWithCandidateProfileByTelegramId(telegramId: bigint) {
        return prisma.user.findUnique({
            where: { telegramId },
            include: { candidate: true }
        });
    }

    async findByStaffProfileId(staffProfileId: string): Promise<User | null> {
        const staff = await prisma.staffProfile.findUnique({
            where: { id: staffProfileId },
            include: { user: true }
        });
        return staff?.user ?? null;
    }

    async findAllWithProfiles() {
        return prisma.user.findMany({
            include: {
                staffProfile: true,
                candidate: true
            }
        });
    }

    async findAll() {
        return prisma.user.findMany();
    }

    async findAllWithStaff() {
        return prisma.user.findMany({
            include: { staffProfile: true }
        });
    }

    async upsert(args: Prisma.UserUpsertArgs): Promise<User> {
        return prisma.user.upsert(args);
    }
}

export const userRepository = new UserRepository();
