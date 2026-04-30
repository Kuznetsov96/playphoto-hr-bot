import { TaskCompletionMode, TaskProofItemType, TaskProofSubmissionStatus } from "@prisma/client";
import type { Message } from "grammy/types";
import logger from "../core/logger.js";
import { taskProofRepository } from "../repositories/task-proof-repository.js";
import { taskRepository } from "../repositories/task-repository.js";

export type TaskProofInput = {
    type: TaskProofItemType;
    text?: string | null;
    telegramFileId?: string | null;
    caption?: string | null;
};

class TaskProofService {
    async startDraft(taskId: string, staffId: string) {
        const task = await taskRepository.findById(taskId);
        if (!task) {
            throw new Error("Task not found");
        }
        if (task.staffId !== staffId) {
            throw new Error("Task does not belong to this staff member");
        }
        if (task.isCompleted) {
            throw new Error("Task is already completed");
        }
        if (task.completionMode !== TaskCompletionMode.PROOF_REQUIRED) {
            throw new Error("Task does not require proof");
        }

        const activeDraft = await taskProofRepository.findActiveDraftByStaffId(staffId);
        if (activeDraft && activeDraft.taskId !== taskId) {
            throw new Error("Another proof draft is already in progress");
        }

        const existing = await taskProofRepository.findByTaskId(taskId);
        if (existing) {
            if (existing.status === TaskProofSubmissionStatus.SUBMITTED) {
                throw new Error("Proof has already been submitted");
            }
            return existing;
        }

        return taskProofRepository.createDraft(taskId, staffId);
    }

    async getDraft(taskId: string) {
        const submission = await taskProofRepository.findByTaskId(taskId);
        if (!submission || submission.status !== TaskProofSubmissionStatus.DRAFT) {
            return null;
        }
        return submission;
    }

    async getActiveDraftByStaffId(staffId: string) {
        return taskProofRepository.findActiveDraftByStaffId(staffId);
    }

    async appendItem(taskId: string, staffId: string, input: TaskProofInput) {
        const draft = await this.startDraft(taskId, staffId);
        await taskProofRepository.addItem(draft.id, input);
        return taskProofRepository.findByTaskId(taskId);
    }

    async cancelDraft(taskId: string, staffId: string) {
        const task = await taskRepository.findById(taskId);
        if (!task || task.staffId !== staffId) {
            return false;
        }

        const draft = await this.getDraft(taskId);
        if (!draft) {
            return false;
        }

        await taskProofRepository.deleteDraft(draft.id);
        return true;
    }

    async submitDraft(taskId: string, staffId: string) {
        const task = await taskRepository.findById(taskId);
        if (!task) {
            throw new Error("Task not found");
        }
        if (task.staffId !== staffId) {
            throw new Error("Task does not belong to this staff member");
        }

        const draft = await this.getDraft(taskId);
        if (!draft) {
            throw new Error("Draft not found");
        }
        if (draft.items.length === 0) {
            throw new Error("Draft is empty");
        }

        const [submission] = await Promise.all([
            taskProofRepository.submit(draft.id),
            taskRepository.update(taskId, {
                isCompleted: true,
                completedAt: new Date(),
            }),
        ]);

        return submission;
    }

    async getSubmission(taskId: string) {
        return taskProofRepository.findByTaskId(taskId);
    }
}

export const taskProofService = new TaskProofService();

export function mapTelegramMessageToTaskProofInput(message: Message): TaskProofInput | null {
    if ("text" in message && typeof message.text === "string" && message.text.trim()) {
        return {
            type: TaskProofItemType.TEXT,
            text: message.text.trim(),
        };
    }

    if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        return {
            type: TaskProofItemType.PHOTO,
            telegramFileId: photo?.file_id ?? null,
            caption: "caption" in message && typeof message.caption === "string" ? message.caption : null,
        };
    }

    if ("video" in message && message.video) {
        return {
            type: TaskProofItemType.VIDEO,
            telegramFileId: message.video.file_id,
            caption: "caption" in message && typeof message.caption === "string" ? message.caption : null,
        };
    }

    if ("document" in message && message.document) {
        return {
            type: TaskProofItemType.DOCUMENT,
            telegramFileId: message.document.file_id,
            caption: "caption" in message && typeof message.caption === "string" ? message.caption : null,
        };
    }

    if ("voice" in message && message.voice) {
        return {
            type: TaskProofItemType.VOICE,
            telegramFileId: message.voice.file_id,
        };
    }

    if ("audio" in message && message.audio) {
        return {
            type: TaskProofItemType.AUDIO,
            telegramFileId: message.audio.file_id,
            caption: "caption" in message && typeof message.caption === "string" ? message.caption : null,
        };
    }

    if ("animation" in message && message.animation) {
        return {
            type: TaskProofItemType.ANIMATION,
            telegramFileId: message.animation.file_id,
            caption: "caption" in message && typeof message.caption === "string" ? message.caption : null,
        };
    }

    logger.debug({ messageId: message.message_id }, "Unsupported task proof message type");
    return null;
}
