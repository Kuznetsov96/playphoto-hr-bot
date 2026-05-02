import { Prisma, TaskProofItemType, TaskProofSubmissionStatus, TaskProofSupportTopicStatus } from "@prisma/client";
import prisma from "../db/core.js";

const proofInclude = {
    items: {
        orderBy: { createdAt: "asc" },
    },
    task: {
        include: {
            staff: {
                include: {
                    user: true,
                    location: true,
                },
            },
        },
    },
    staff: {
        include: {
            user: true,
            location: true,
        },
    },
} satisfies Prisma.TaskProofSubmissionInclude;

export class TaskProofRepository {
    async findById(submissionId: string) {
        return prisma.taskProofSubmission.findUnique({
            where: { id: submissionId },
            include: proofInclude,
        });
    }

    async findByTaskId(taskId: string) {
        return prisma.taskProofSubmission.findUnique({
            where: { taskId },
            include: proofInclude,
        });
    }

    async findActiveDraftByStaffId(staffId: string) {
        return prisma.taskProofSubmission.findFirst({
            where: {
                staffId,
                status: TaskProofSubmissionStatus.DRAFT,
            },
            include: proofInclude,
            orderBy: { updatedAt: "desc" },
        });
    }

    async createDraft(taskId: string, staffId: string) {
        return prisma.taskProofSubmission.create({
            data: {
                task: { connect: { id: taskId } },
                staff: { connect: { id: staffId } },
                status: TaskProofSubmissionStatus.DRAFT,
            },
            include: proofInclude,
        });
    }

    async touchDraft(submissionId: string) {
        return prisma.taskProofSubmission.update({
            where: { id: submissionId },
            data: { updatedAt: new Date() },
            include: proofInclude,
        });
    }

    async addItem(
        submissionId: string,
        data: {
            type: TaskProofItemType;
            text?: string | null;
            telegramFileId?: string | null;
            caption?: string | null;
        },
    ) {
        return prisma.$transaction(async (tx) => {
            const item = await tx.taskProofItem.create({
                data: {
                    submission: { connect: { id: submissionId } },
                    type: data.type,
                    text: data.text ?? null,
                    telegramFileId: data.telegramFileId ?? null,
                    caption: data.caption ?? null,
                },
            });

            await tx.taskProofSubmission.update({
                where: { id: submissionId },
                data: { lastItemAt: new Date() },
            });

            return item;
        });
    }

    async deleteDraft(submissionId: string) {
        return prisma.taskProofSubmission.delete({
            where: { id: submissionId },
        });
    }

    async submit(submissionId: string) {
        return prisma.taskProofSubmission.update({
            where: { id: submissionId },
            data: {
                status: TaskProofSubmissionStatus.SUBMITTED,
                submittedAt: new Date(),
            },
            include: proofInclude,
        });
    }

    async attachSupportTopic(
        submissionId: string,
        data: {
            supportChatId: bigint;
            supportTopicId: number;
            supportTopicStatus: TaskProofSupportTopicStatus;
        },
    ) {
        return prisma.taskProofSubmission.update({
            where: { id: submissionId },
            data: {
                supportChatId: data.supportChatId,
                supportTopicId: data.supportTopicId,
                supportTopicStatus: data.supportTopicStatus,
                supportTopicOpenedAt: new Date(),
                supportTopicClosedAt: null,
                supportLastMessageAt: new Date(),
            },
            include: proofInclude,
        });
    }

    async updateSupportTopicState(
        submissionId: string,
        data: {
            supportTopicStatus?: TaskProofSupportTopicStatus;
            supportLastMessageAt?: Date;
            supportTopicClosedAt?: Date | null;
        },
    ) {
        return prisma.taskProofSubmission.update({
            where: { id: submissionId },
            data,
            include: proofInclude,
        });
    }

    async findBySupportTopic(chatId: bigint, topicId: number) {
        return prisma.taskProofSubmission.findFirst({
            where: {
                supportChatId: chatId,
                supportTopicId: topicId,
            },
            include: proofInclude,
        });
    }

    async findLatestWaitingForStaffByStaffId(staffId: string) {
        return prisma.taskProofSubmission.findFirst({
            where: {
                staffId,
                status: TaskProofSubmissionStatus.SUBMITTED,
                supportTopicStatus: TaskProofSupportTopicStatus.WAITING_FOR_STAFF,
            },
            include: proofInclude,
            orderBy: [
                { supportLastMessageAt: "desc" },
                { updatedAt: "desc" },
            ],
        });
    }
}

export const taskProofRepository = new TaskProofRepository();
