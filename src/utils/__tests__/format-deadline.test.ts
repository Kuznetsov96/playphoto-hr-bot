import { describe, expect, it } from "vitest";
import { formatDeadline, formatLocalDate, isTaskUrgent, URGENT_DEADLINE_WINDOW_HOURS } from "../format-deadline.js";

describe("formatDeadline", () => {
    it("выводит день недели из самой даты, а не из шаблона", () => {
        // 26 августа 2026 — среда.
        expect(formatDeadline(new Date("2026-08-26T12:00:00.000Z"))).toBe("26 серпня, середа");
    });

    it("берёт день в киевской зоне, а не в UTC", () => {
        // 21:30 UTC 25-го — это уже 26-е в Киеве (UTC+3 летом). Дедлайн в
        // 23:59 местного времени иначе назвал бы соседний день.
        expect(formatDeadline(new Date("2026-08-25T21:30:00.000Z"))).toBe("26 серпня, середа");
    });

    it("склоняет месяц в родительный падеж", () => {
        expect(formatDeadline(new Date("2026-09-30T12:00:00.000Z"))).toBe("30 вересня, середа");
    });

    it("переживает переход через год", () => {
        expect(formatDeadline(new Date("2026-12-26T12:00:00.000Z"))).toBe("26 грудня, субота");
    });

    it("не путает воскресенье с началом недели", () => {
        // 2026-08-30 — воскресенье. В JS getDay() для него 0, и наивная
        // индексация массива, начинающегося с понедельника, дала бы пятницу.
        expect(formatDeadline(new Date("2026-08-30T12:00:00.000Z"))).toBe("30 серпня, неділя");
    });
});

describe("formatLocalDate", () => {
    it("names a calendar date from the web app with its weekday", () => {
        // Срок сбора приходит из вебаппа датой `YYYY-MM-DD`, не моментом.
        expect(formatLocalDate("2026-10-26")).toBe("26 жовтня, понеділок");
    });

    it("does not shift the day whatever the server zone", () => {
        expect(formatLocalDate("2026-08-30")).toBe("30 серпня, неділя");
        expect(formatLocalDate("2026-12-31")).toBe("31 грудня, четвер");
    });
});

describe("isTaskUrgent", () => {
    // 2026-09-17 is a Kyiv summer date (UTC+3). "now" fixed at 10:00 Kyiv = 07:00 UTC.
    const NOW = new Date("2026-09-17T07:00:00.000Z");
    const TODAY_WORK_DATE = new Date("2026-09-17T00:00:00.000Z");

    it("is never urgent once completed, regardless of deadline", () => {
        expect(isTaskUrgent({ isCompleted: true, workDate: TODAY_WORK_DATE, deadlineTime: "07:30" }, NOW)).toBe(false);
    });

    it("is not urgent with no workDate at all", () => {
        expect(isTaskUrgent({ isCompleted: false, workDate: null, deadlineTime: "18:00" }, NOW)).toBe(false);
    });

    it("is always urgent once the task's day is in the past — overdue, regardless of deadline time", () => {
        const yesterday = new Date("2026-09-16T00:00:00.000Z");
        expect(isTaskUrgent({ isCompleted: false, workDate: yesterday, deadlineTime: "23:59" }, NOW)).toBe(true);
        expect(isTaskUrgent({ isCompleted: false, workDate: yesterday, deadlineTime: null }, NOW)).toBe(true);
    });

    it("is not urgent for a future day, even with an early deadline time", () => {
        const tomorrow = new Date("2026-09-18T00:00:00.000Z");
        expect(isTaskUrgent({ isCompleted: false, workDate: tomorrow, deadlineTime: "10:30" }, NOW)).toBe(false);
    });

    it("due today with no deadline time set is not urgent — nothing to count down to", () => {
        expect(isTaskUrgent({ isCompleted: false, workDate: TODAY_WORK_DATE, deadlineTime: null }, NOW)).toBe(false);
    });

    // This is the exact regression from the audit: "end of day" two weeks out
    // (or, once workDate is checked, simply "much later today") must not
    // light up the 🚨 URGENT block just because a deadline exists.
    it("due today but far beyond the window is not urgent", () => {
        // 23:59 Kyiv is ~14 hours away from 10:00 Kyiv — well past the window.
        expect(isTaskUrgent({ isCompleted: false, workDate: TODAY_WORK_DATE, deadlineTime: "23:59" }, NOW)).toBe(false);
    });

    it("becomes urgent once inside the window", () => {
        // Deadline exactly URGENT_DEADLINE_WINDOW_HOURS away.
        const deadline = new Date(NOW.getTime() + URGENT_DEADLINE_WINDOW_HOURS * 60 * 60 * 1000);
        const kyivTime = deadline.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
        expect(isTaskUrgent({ isCompleted: false, workDate: TODAY_WORK_DATE, deadlineTime: kyivTime }, NOW)).toBe(true);

        // One hour further out (outside the window) is not urgent.
        const tooFar = new Date(NOW.getTime() + (URGENT_DEADLINE_WINDOW_HOURS + 1) * 60 * 60 * 1000);
        const tooFarKyivTime = tooFar.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
        expect(isTaskUrgent({ isCompleted: false, workDate: TODAY_WORK_DATE, deadlineTime: tooFarKyivTime }, NOW)).toBe(false);
    });

    it("is urgent (overdue) once today's deadline time has already passed", () => {
        expect(isTaskUrgent({ isCompleted: false, workDate: TODAY_WORK_DATE, deadlineTime: "06:00" }, NOW)).toBe(true);
    });
});
