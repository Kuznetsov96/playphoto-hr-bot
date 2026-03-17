
import { z } from "zod";
import { taskRepository } from "../repositories/task-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";

// Zod schemas
const CreateTaskSchema = z.object({
    staffId: z.string().cuid(),
    taskText: z.string().min(1, "Task text cannot be empty"),
    workDate: z.date().nullable().optional(),
    deadlineTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Time must be HH:MM").nullable().optional(),
    city: z.string().nullable().optional(),
    locationName: z.string().nullable().optional(),
    fileId: z.string().nullable().optional(),
    createdById: z.string(),
});

const UpdateTaskStatusSchema = z.object({
    taskId: z.string().cuid(),
    isCompleted: z.boolean(),
});

type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusSchema>;

export class TaskService {
    /**
     * Create a new task for a staff member
     */
    async createTask(input: CreateTaskInput) {
        const validated = CreateTaskSchema.parse(input);

        return taskRepository.create({
            staff: { connect: { id: validated.staffId } },
            taskText: validated.taskText,
            workDate: validated.workDate ?? null,
            deadlineTime: validated.deadlineTime ?? null,
            city: validated.city ?? null,
            locationName: validated.locationName ?? null,
            fileId: validated.fileId ?? null,
            createdById: validated.createdById,
            isCompleted: false
        });
    }

    /**
     * Get task by ID
     */
    async getTaskById(taskId: string) {
        return taskRepository.findById(taskId);
    }

    /**
     * Get tasks for a specific date
     */
    async getTasksForDate(date: Date, hideCompleted = false) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return taskRepository.findByDateRange(startOfDay, endOfDay, hideCompleted);
    }

    /**
     * Toggle task completion status
     */
    async toggleTaskStatus(taskId: string) {
        const task = await taskRepository.findById(taskId);

        if (!task) {
            throw new Error("Task not found");
        }

        return taskRepository.update(taskId, {
            isCompleted: !task.isCompleted
        });
    }

    /**
     * Mark reminder as sent
     */
    async markReminderSent(taskId: string) {
        return taskRepository.update(taskId, { reminderSentAt: new Date() });
    }

    /**
     * Mark morning digest as sent for staff
     */
    async markDigestSent(staffId: string) {
        return staffRepository.update(staffId, { lastTaskDigestAt: new Date() });
    }

    /**
     * Delete a task
     */
    async deleteTask(taskId: string) {
        return taskRepository.delete(taskId);
    }

    /**
     * Get all active tasks for a staff member
     */
    async getStaffActiveTasks(staffId: string) {
        return taskRepository.findActiveByStaffId(staffId);
    }

    /**
     * Get tasks nearing deadline
     */
    async getTasksNearingDeadline(date: Date, hoursBeforeDeadline = 1) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return taskRepository.findNearingDeadline(startOfDay, endOfDay);
        // Note: The repository logic for filtering by exact 'hoursBeforeDeadline' is missing here compared to finding all with deadline.
        // But the previous implementation just fetched all with deadline on that day and filter logic might be in caller or just assuming 'nearing' means has deadline.
        // Wait, checking original service...
        // Original logic: just fetched tasks with deadline today that are not completed and reminderSentAt null.
        // It didn't actually check 'hoursBeforeDeadline'. So this matches behavior.
    }

    /**
     * Get overdue tasks
     */
    async getOverdueTasks(date: Date) {
        const now = new Date();
        const kyivTime = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Kyiv' });

        // Using helper logic, but pass time string
        return taskRepository.findOverdue(date, kyivTime);
    }

    /**
     * Mark usage admin notification sent
     */
    async markOverdueAdminNotified(taskId: string) {
        return taskRepository.update(taskId, { overdueAdminNotifiedAt: new Date() });
    }

    /**
     * Count overdue tasks
     */
    async countOverdueTasks(date: Date) {
        const now = new Date();
        const kyivTime = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Kyiv' });

        return taskRepository.countOverdue(date, kyivTime);
    }


    /**
     * Get staff for morning digest
     */
    async getStaffForMorningDigest(date: Date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return staffRepository.findForMorningDigest(startOfDay, endOfDay);
    }

    /**
     * Get staff IDs with tasks for date
     */
    async getStaffWithTasksForDate(date: Date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return taskRepository.findStaffIdsWithTasks(startOfDay, endOfDay);
    }

    /**
     * Complete task
     */
    async completeTask(taskId: string) {
        return taskRepository.update(taskId, { isCompleted: true });
    }
}

export const taskService = new TaskService();
