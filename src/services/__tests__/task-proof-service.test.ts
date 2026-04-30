import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCompletionMode, TaskProofItemType, TaskProofSubmissionStatus } from "@prisma/client";

const taskRepository = {
    findById: vi.fn(),
    update: vi.fn(),
};

const taskProofRepository = {
    findByTaskId: vi.fn(),
    findActiveDraftByStaffId: vi.fn(),
    createDraft: vi.fn(),
    addItem: vi.fn(),
    deleteDraft: vi.fn(),
    submit: vi.fn(),
};

vi.mock("../../repositories/task-repository.js", () => ({
    taskRepository,
}));

vi.mock("../../repositories/task-proof-repository.js", () => ({
    taskProofRepository,
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe("taskProofService", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("rejects proof collection for quick tasks", async () => {
        taskRepository.findById.mockResolvedValue({
            id: "task-1",
            staffId: "staff-1",
            isCompleted: false,
            completionMode: TaskCompletionMode.QUICK,
        });

        const { taskProofService } = await import("../task-proof-service.js");

        await expect(taskProofService.startDraft("task-1", "staff-1")).rejects.toThrow("Task does not require proof");
        expect(taskProofRepository.createDraft).not.toHaveBeenCalled();
    });

    it("prevents starting another proof draft for the same staff member", async () => {
        taskRepository.findById.mockResolvedValue({
            id: "task-2",
            staffId: "staff-1",
            isCompleted: false,
            completionMode: TaskCompletionMode.PROOF_REQUIRED,
        });
        taskProofRepository.findActiveDraftByStaffId.mockResolvedValue({
            id: "draft-1",
            taskId: "another-task",
            staffId: "staff-1",
            status: TaskProofSubmissionStatus.DRAFT,
        });

        const { taskProofService } = await import("../task-proof-service.js");

        await expect(taskProofService.startDraft("task-2", "staff-1")).rejects.toThrow("Another proof draft is already in progress");
    });

    it("submits a non-empty draft and completes the task", async () => {
        taskRepository.findById.mockResolvedValue({
            id: "task-3",
            staffId: "staff-1",
            isCompleted: false,
            completionMode: TaskCompletionMode.PROOF_REQUIRED,
        });
        taskProofRepository.findByTaskId.mockResolvedValue({
            id: "draft-3",
            taskId: "task-3",
            staffId: "staff-1",
            status: TaskProofSubmissionStatus.DRAFT,
            items: [{ id: "item-1", type: TaskProofItemType.TEXT, text: "done" }],
        });
        taskProofRepository.submit.mockResolvedValue({
            id: "draft-3",
            taskId: "task-3",
            staffId: "staff-1",
            status: TaskProofSubmissionStatus.SUBMITTED,
            items: [{ id: "item-1", type: TaskProofItemType.TEXT, text: "done" }],
        });

        const { taskProofService } = await import("../task-proof-service.js");

        const result = await taskProofService.submitDraft("task-3", "staff-1");

        expect(taskProofRepository.submit).toHaveBeenCalledWith("draft-3");
        expect(taskRepository.update).toHaveBeenCalledWith(
            "task-3",
            expect.objectContaining({
                isCompleted: true,
                completedAt: expect.any(Date),
            }),
        );
        expect(result.status).toBe(TaskProofSubmissionStatus.SUBMITTED);
    });

    it("rejects submitting an empty draft", async () => {
        taskRepository.findById.mockResolvedValue({
            id: "task-4",
            staffId: "staff-1",
            isCompleted: false,
            completionMode: TaskCompletionMode.PROOF_REQUIRED,
        });
        taskProofRepository.findByTaskId.mockResolvedValue({
            id: "draft-4",
            taskId: "task-4",
            staffId: "staff-1",
            status: TaskProofSubmissionStatus.DRAFT,
            items: [],
        });

        const { taskProofService } = await import("../task-proof-service.js");

        await expect(taskProofService.submitDraft("task-4", "staff-1")).rejects.toThrow("Draft is empty");
        expect(taskRepository.update).not.toHaveBeenCalled();
    });
});
