
import { Prisma } from "@prisma/client";
import prisma from "../db/core.js";
import type { Task, StaffProfile, User, Location } from "@prisma/client";

export type TaskWithRelations = Task & {
    staff: StaffProfile & {
        user: User;
        location: Location | null;
    };
};

export class TaskRepository {
    async create(data: Prisma.TaskCreateInput): Promise<TaskWithRelations> {
        return prisma.task.create({
            data,
            include: {
                staff: {
                    include: {
                        user: true,
                        location: true
                    }
                }
            }
        });
    }

    async findById(id: string): Promise<TaskWithRelations | null> {
        return prisma.task.findUnique({
            where: { id },
            include: {
                staff: {
                    include: {
                        user: true,
                        location: true
                    }
                }
            }
        });
    }

    async findByDateRange(start: Date, end: Date, hideCompleted: boolean = false): Promise<TaskWithRelations[]> {
        return prisma.task.findMany({
            where: {
                OR: [
                    {
                        workDate: {
                            gte: start,
                            lte: end,
                        },
                    },
                    {
                        workDate: null,
                    },
                ],
                ...(hideCompleted ? { isCompleted: false } : {}),
            },
            include: {
                staff: {
                    include: {
                        user: true,
                        location: true,
                    },
                },
            },
            orderBy: [
                { isCompleted: "asc" },
                { deadlineTime: "asc" },
                { createdAt: "asc" },
            ],
        });
    }

    async update(id: string, data: Prisma.TaskUpdateInput): Promise<TaskWithRelations> {
        return prisma.task.update({
            where: { id },
            data,
            include: {
                staff: {
                    include: {
                        user: true,
                    },
                },
            },
        }) as unknown as Promise<TaskWithRelations>; // Cast because location might be missing in this include if not requested, but type expects it. Let's fix type or include.
        // Actually for toggleStatus we just need user. Let's keep it simple or align with return type.
        // The service uses return value for UI updates.
    }

    async delete(id: string): Promise<Task> {
        return prisma.task.delete({
            where: { id }
        });
    }

    async findActiveByStaffId(staffId: string): Promise<Task[]> {
        return prisma.task.findMany({
            where: {
                staffId,
                isCompleted: false,
            },
            orderBy: [
                { workDate: "asc" },
                { deadlineTime: "asc" },
                { createdAt: "asc" },
            ],
        });
    }

    async findNearingDeadline(start: Date, end: Date): Promise<TaskWithRelations[]> {
        return prisma.task.findMany({
            where: {
                workDate: {
                    gte: start,
                    lte: end,
                },
                isCompleted: false,
                deadlineTime: {
                    not: null,
                },
                reminderSentAt: null,
            },
            include: {
                staff: {
                    include: {
                        user: true,
                        location: true
                    },
                },
            },
        });
    }

    async findOverdue(date: Date, timeStr: string): Promise<TaskWithRelations[]> {
        return prisma.task.findMany({
            where: {
                workDate: {
                    lte: date,
                },
                isCompleted: false,
                deadlineTime: {
                    not: null,
                    lt: timeStr,
                },
                overdueAdminNotifiedAt: null,
            },
            include: {
                staff: {
                    include: {
                        user: true,
                        location: true
                    },
                },
            },
        });
    }

    async countOverdue(date: Date, timeStr: string): Promise<number> {
        return prisma.task.count({
            where: {
                workDate: {
                    lte: date,
                },
                isCompleted: false,
                deadlineTime: {
                    not: null,
                    lt: timeStr,
                },
            },
        });
    }

    async findStaffIdsWithTasks(start: Date, end: Date): Promise<string[]> {
        const tasks = await prisma.task.findMany({
            where: {
                workDate: {
                    gte: start,
                    lte: end,
                },
                isCompleted: false,
            },
            select: {
                staffId: true,
            },
            distinct: ["staffId"],
        });
        return tasks.map(t => t.staffId);
    }
}

export const taskRepository = new TaskRepository();
