
import { Prisma } from "@prisma/client";
import prisma from "../db/core.js";
import type { Task, StaffProfile, User, Location, TaskProofSubmission, TaskProofItem } from "@prisma/client";

export type TaskWithRelations = Task & {
    staff: StaffProfile & {
        user: User;
        location: Location | null;
    };
    proofSubmission?: (TaskProofSubmission & {
        items: TaskProofItem[];
    }) | null;
};

const taskInclude = {
    staff: {
        include: {
            user: true,
            location: true,
        },
    },
    proofSubmission: {
        include: {
            items: {
                orderBy: { createdAt: "asc" },
            },
        },
    },
} satisfies Prisma.TaskInclude;

export class TaskRepository {
    async create(data: Prisma.TaskCreateInput): Promise<TaskWithRelations> {
        return prisma.task.create({
            data,
            include: taskInclude,
        });
    }

    async findById(id: string): Promise<TaskWithRelations | null> {
        return prisma.task.findUnique({
            where: { id },
            include: taskInclude,
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
            include: taskInclude,
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
            include: taskInclude,
        });
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
                ...taskInclude,
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
                ...taskInclude,
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
