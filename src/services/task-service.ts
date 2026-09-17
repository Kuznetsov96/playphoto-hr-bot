
import { TaskCompletionMode } from "@prisma/client";
import { z } from "zod";
import { taskRepository, type TaskWithRelations } from "../repositories/task-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";

export const TASK_TEXT_MAX_LENGTH = 3000;

export type BulkTaskCreationResult = {
    created: { staffId: string; taskId: string; telegramId: bigint | null }[];
    failed: { staffId: string; error: string }[];
};

export type BulkTaskCreationInput = {
    staffIds: string[];
    taskText: string;
    workDate: Date;
    deadlineTime: string | null;
    fileId: string | null;
    createdById: string;
    completionMode: TaskCompletionMode;
    telegramIdByStaffId: Map<string, bigint | null>;
};

// Zod schemas
const CreateTaskSchema = z.object({
    staffId: z.string().cuid(),
    taskText: z.string()
        .min(1, "Task text cannot be empty")
        .max(TASK_TEXT_MAX_LENGTH, `Task text cannot exceed ${TASK_TEXT_MAX_LENGTH} characters`),
    workDate: z.date().nullable().optional(),
    deadlineTime: z.string().regex(/^\d{1,2}:\d{2}$/, "Time must be HH:MM").nullable().optional(),
    city: z.string().nullable().optional(),
    locationName: z.string().nullable().optional(),
    fileId: z.string().nullable().optional(),
    createdById: z.string(),
    completionMode: z.nativeEnum(TaskCompletionMode).default(TaskCompletionMode.QUICK),
});

const UpdateTaskStatusSchema = z.object({
    taskId: z.string().cuid(),
    isCompleted: z.boolean(),
});

type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusSchema>;

export class TaskService {
    private async resolveTaskLocation(staffId: string, workDate?: Date | null, fallbackCity?: string | null, fallbackLocationName?: string | null) {
        if (workDate) {
            const shift = await workShiftRepository.findShiftWithLocationOnDate(staffId, workDate);
            if (shift?.location) {
                return {
                    city: shift.location.city,
                    locationName: shift.location.name,
                };
            }
        }

        if (fallbackCity || fallbackLocationName) {
            return {
                city: fallbackCity ?? null,
                locationName: fallbackLocationName ?? null,
            };
        }

        const staff = await staffRepository.findById(staffId);
        return {
            city: staff?.location?.city ?? null,
            locationName: staff?.location?.name ?? null,
        };
    }

    private async hydrateTaskLocation(task: TaskWithRelations | null): Promise<TaskWithRelations | null> {
        if (!task) return null;

        const resolvedLocation = await this.resolveTaskLocation(
            task.staffId,
            task.workDate,
            task.city ?? null,
            task.locationName ?? null,
        );

        return {
            ...task,
            city: resolvedLocation.city,
            locationName: resolvedLocation.locationName,
        };
    }

    /**
     * Same resolution as `resolveTaskLocation`/`hydrateTaskLocation`, but for a whole list of
     * tasks at once: one query fetches every relevant shift instead of one query (plus a
     * possible second `staffRepository.findById`) per task. A dashboard day of 30 tasks would
     * otherwise cost 31-61 queries for data a single shift lookup already covers.
     *
     * Priority is unchanged: shift location for that staff member on that task's workDate,
     * then the task's own city/locationName fallback, then the staff member's home location
     * (already loaded on `task.staff.location` via `taskInclude` — no extra query needed).
     */
    private async hydrateTaskLocations(tasks: TaskWithRelations[]): Promise<TaskWithRelations[]> {
        if (tasks.length === 0) return [];

        const pairs = tasks
            .filter((task): task is TaskWithRelations & { workDate: Date } => task.workDate != null)
            .map((task) => ({ staffId: task.staffId, date: task.workDate }));

        const shifts = pairs.length > 0
            ? await workShiftRepository.findShiftsWithLocationForStaffOnDates(pairs)
            : [];

        // Keyed by staffId + calendar day so each task can look up its own shift without
        // rescanning the whole list.
        const shiftByStaffAndDay = new Map<string, (typeof shifts)[number]>();
        for (const shift of shifts) {
            const day = new Date(shift.date);
            day.setHours(0, 0, 0, 0);
            shiftByStaffAndDay.set(`${shift.staffId}:${day.getTime()}`, shift);
        }

        return tasks.map((task) => {
            let city: string | null = null;
            let locationName: string | null = null;

            if (task.workDate) {
                const day = new Date(task.workDate);
                day.setHours(0, 0, 0, 0);
                const shift = shiftByStaffAndDay.get(`${task.staffId}:${day.getTime()}`);
                if (shift?.location) {
                    city = shift.location.city;
                    locationName = shift.location.name;
                }
            }

            if (city === null && locationName === null) {
                if (task.city || task.locationName) {
                    city = task.city ?? null;
                    locationName = task.locationName ?? null;
                } else {
                    city = task.staff?.location?.city ?? null;
                    locationName = task.staff?.location?.name ?? null;
                }
            }

            return { ...task, city, locationName };
        });
    }

    /**
     * Create a new task for a staff member
     */
    async createTask(input: CreateTaskInput) {
        const validated = CreateTaskSchema.parse(input);
        const resolvedLocation = await this.resolveTaskLocation(
            validated.staffId,
            validated.workDate,
            validated.city ?? null,
            validated.locationName ?? null,
        );

        return taskRepository.create({
            staff: { connect: { id: validated.staffId } },
            taskText: validated.taskText,
            workDate: validated.workDate ?? null,
            deadlineTime: validated.deadlineTime ?? null,
            city: resolvedLocation.city,
            locationName: resolvedLocation.locationName,
            fileId: validated.fileId ?? null,
            createdById: validated.createdById,
            completionMode: validated.completionMode,
            isCompleted: false,
            completedAt: null,
        });
    }

    /**
     * Создать задачу каждому сотруднику из списка.
     * Падение на одном сотруднике не прерывает остальных: задача либо создана,
     * либо попадает в failed с текстом ошибки.
     */
    async createTasksBulk(input: BulkTaskCreationInput): Promise<BulkTaskCreationResult> {
        const result: BulkTaskCreationResult = { created: [], failed: [] };

        for (const staffId of input.staffIds) {
            try {
                const task = await this.createTask({
                    staffId,
                    taskText: input.taskText,
                    workDate: input.workDate,
                    deadlineTime: input.deadlineTime,
                    city: null,
                    locationName: null,
                    fileId: input.fileId,
                    createdById: input.createdById,
                    completionMode: input.completionMode,
                });

                result.created.push({
                    staffId,
                    taskId: task.id,
                    telegramId: input.telegramIdByStaffId.get(staffId) ?? null,
                });
            } catch (error: any) {
                result.failed.push({ staffId, error: error?.message ?? String(error) });
            }
        }

        return result;
    }

    /**
     * Get task by ID
     */
    async getTaskById(taskId: string) {
        const task = await taskRepository.findById(taskId);
        return this.hydrateTaskLocation(task);
    }

    /**
     * Get tasks for a specific date
     */
    async getTasksForDate(date: Date, hideCompleted = false) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        const tasks = await taskRepository.findByDateRange(startOfDay, endOfDay, hideCompleted);
        return this.hydrateTaskLocations(tasks);
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
            isCompleted: !task.isCompleted,
            completedAt: task.isCompleted ? null : new Date(),
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
        return taskRepository.update(taskId, {
            isCompleted: true,
            completedAt: new Date(),
        });
    }
}

export const taskService = new TaskService();
