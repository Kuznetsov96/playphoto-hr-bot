import { describe, expect, it } from "vitest";
import {
    buildTaskNotificationText,
    TASK_NOTIFICATION_BUTTON_CALLBACK,
    taskNotificationButtonLabel,
} from "../task-notification.js";

/**
 * Divergence A з аудиту вирівнювання майстрів постановки задач: фотографиня
 * отримувала різний текст залежно від того, з якого адмінського екрана їй
 * поставили завдання. Тепер усі три майстри (task-creation.ts, task-flow.ts,
 * task-bulk.ts) збирають повідомлення через цей спільний білдер.
 */
describe("buildTaskNotificationText", () => {
    const base = { text: "Помити студію", date: "17.09.2026" };

    it("produces the same text regardless of which flow supplies identical input", () => {
        const fromDashboard = buildTaskNotificationText({ ...base, deadlineTime: "18:00", completionMode: "QUICK" });
        const fromProfile = buildTaskNotificationText({ ...base, deadlineTime: "18:00", completionMode: "QUICK" });
        const fromBulk = buildTaskNotificationText({ ...base, deadlineTime: "18:00", completionMode: "QUICK" });

        expect(fromDashboard).toBe(fromProfile);
        expect(fromProfile).toBe(fromBulk);
    });

    it("includes the task text and date", () => {
        const text = buildTaskNotificationText(base);
        expect(text).toContain("Помити студію");
        expect(text).toContain("17.09.2026");
    });

    it("includes the deadline when provided", () => {
        const withDeadline = buildTaskNotificationText({ ...base, deadlineTime: "18:00" });
        const withoutDeadline = buildTaskNotificationText({ ...base, deadlineTime: null });

        expect(withDeadline).toContain("18:00");
        expect(withoutDeadline).not.toContain("⏰");
    });

    it("adds the completion hint only for PROOF_REQUIRED tasks", () => {
        const proofRequired = buildTaskNotificationText({ ...base, completionMode: "PROOF_REQUIRED" });
        const quick = buildTaskNotificationText({ ...base, completionMode: "QUICK" });
        const unset = buildTaskNotificationText(base);

        expect(proofRequired).toContain("Мої завдання");
        expect(quick).not.toContain("Мої завдання");
        expect(unset).not.toContain("Мої завдання");
    });

    it("exposes a button callback that routes straight to the staff task list", () => {
        expect(TASK_NOTIFICATION_BUTTON_CALLBACK).toBe("staff_hub_tasks_redirect");
        expect(taskNotificationButtonLabel().length).toBeGreaterThan(0);
    });
});
