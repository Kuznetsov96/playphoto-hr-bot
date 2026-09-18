import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_MESSAGE_LIMIT } from "../../../constants/telegram-limits.js";

const getTasksForDate = vi.fn();

vi.mock("../../../services/task-service.js", () => ({
    taskService: { getTasksForDate: (...a: unknown[]) => getTasksForDate(...a) },
}));
vi.mock("../../../services/task-proof-service.js", () => ({ taskProofService: {} }));
vi.mock("../../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
vi.mock("../../../middleware/role-check.js", () => ({ getUserAdminRole: vi.fn() }));

const { buildTasksDashboard } = await import("../tasks.js");

// A fixed date in the past, independent of when the suite actually runs.
// isTaskUrgent treats any incomplete task whose workDate has already passed
// as unconditionally urgent (overdue), so fixtures built on this date stay
// "urgent" no matter what real wall-clock time the test executes at — unlike
// "today + deadlineTime", whose urgency now depends on proximity to `now`.
const PAST_WORK_DATE = new Date("2020-01-06T00:00:00.000Z");

// Дзеркальна пара до PAST_WORK_DATE, і так само навмисна: isTaskUrgent вважає
// НЕтерміновою задачу, день якої ще попереду, хай який у неї deadlineTime.
// Дефолт тут раніше був жорстким "2026-09-17" — і лишався нетерміновим рівно
// доти, доки той день не настав: з 18.09.2026 усі 20 фікстур стали простроченими
// й сьюта падала щопрогону. Дата, полічена від `now`, так протухнути не може.
const futureWorkDate = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

function makeTask(overrides: Partial<{
    id: string;
    isCompleted: boolean;
    deadlineTime: string | null;
    city: string;
    locationName: string;
    fullName: string;
    workDate: Date;
}> = {}) {
    const id = overrides.id ?? `task-${Math.random().toString(36).slice(2)}`;
    return {
        id,
        isCompleted: overrides.isCompleted ?? false,
        deadlineTime: overrides.deadlineTime ?? null,
        city: overrides.city ?? "Kyiv",
        locationName: overrides.locationName ?? "Podil",
        taskText: "Do the thing",
        workDate: overrides.workDate ?? futureWorkDate(),
        completionMode: "QUICK",
        fileId: null,
        staff: {
            fullName: overrides.fullName ?? "Petrenko Ivan",
            location: { city: overrides.city ?? "Kyiv", name: overrides.locationName ?? "Podil" },
        },
    } as any;
}

describe("buildTasksDashboard pagination", () => {
    it("limits the text body to the current page's tasks while the header counters cover the whole day", async () => {
        // 20 tasks total, 3 of them urgent and none completed. PAGE_SIZE is 8,
        // so page 0 should only describe its own 8 tasks in the body, but the
        // header must still say 20 total / 3 urgent.
        const tasks = [
            ...Array.from({ length: 3 }, (_, i) => makeTask({ id: `urgent-${i}`, deadlineTime: "18:00", workDate: PAST_WORK_DATE, fullName: `Urgent${i} Staff${i}` })),
            ...Array.from({ length: 17 }, (_, i) => makeTask({ id: `regular-${i}`, fullName: `Regular${i} Staff${i}` })),
        ];
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 0);

        // Header counts reflect the whole day.
        expect(text).toContain("0/20");
        expect(text).toContain("3");
        expect(text).toMatch(/🚨 <b>3<\/b> urgent/);

        // Only page 0's tasks (first 8 of the 20, by original ordering) appear
        // by name; tasks from later pages must not be rendered into the text.
        for (let i = 0; i < 3; i++) {
            expect(text).toContain(`Urgent${i}`);
        }
        // Page 0 = tasks[0..7] = 3 urgent + 5 regular (regular-0..regular-4).
        for (let i = 0; i < 5; i++) {
            expect(text).toContain(`Regular${i}`);
        }
        // regular-5 onward belongs to a later page and must be absent.
        for (let i = 5; i < 17; i++) {
            expect(text).not.toContain(`Regular${i}`);
        }
    });

    it("shows a page indicator when there is more than one page", async () => {
        const tasks = Array.from({ length: 20 }, (_, i) => makeTask({ id: `t-${i}`, fullName: `Staff${i} Last${i}` }));
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 1);

        expect(text).toContain("2/3");
    });

    it("omits the page indicator when everything fits on one page", async () => {
        const tasks = Array.from({ length: 5 }, (_, i) => makeTask({ id: `t-${i}` }));
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 0);

        expect(text).not.toMatch(/Page \d/);
    });

    it("stays under the Telegram message limit on a pathological 60-task day", async () => {
        // Long-ish, varied names and locations across many cities so the
        // grouped section is not trivially short.
        const tasks = Array.from({ length: 60 }, (_, i) => makeTask({
            id: `pathological-${i}`,
            fullName: `Прізвищенко-Довжелезне${i} Іменище${i}`,
            city: i % 5 === 0 ? "Дніпропетровськ-Наддніпрянський" : "Kyiv",
            locationName: `Фотостудія на вулиці Соборній, корпус номер ${i}`,
            deadlineTime: i % 4 === 0 ? "18:00" : null,
            workDate: i % 4 === 0 ? PAST_WORK_DATE : futureWorkDate(),
        }));
        getTasksForDate.mockResolvedValue(tasks);

        for (let page = 0; page < 8; page++) {
            const { text } = await buildTasksDashboard("2026-09-17", page);
            expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
        }
    });
});

describe("buildTasksDashboard hideCompleted toggle (ITEM 5)", () => {
    it("shows every task by default (hideCompleted defaults to false)", async () => {
        const tasks = [
            makeTask({ id: "done-1", isCompleted: true, fullName: "Done One" }),
            makeTask({ id: "pending-1", isCompleted: false, fullName: "Pending One" }),
        ];
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 0);

        expect(text).toContain("Done One");
        expect(text).toContain("Pending One");
        expect(text).toContain("1/2");
    });

    it("hides completed rows from the body while the header still counts them", async () => {
        const tasks = [
            makeTask({ id: "done-1", isCompleted: true, fullName: "Done One" }),
            makeTask({ id: "done-2", isCompleted: true, fullName: "Done Two" }),
            makeTask({ id: "pending-1", isCompleted: false, fullName: "Pending One" }),
        ];
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 0, true);

        // Header still summarizes the WHOLE day, toggle or not.
        expect(text).toContain("2/3");
        // But the completed rows themselves are gone from the body.
        expect(text).not.toContain("Done One");
        expect(text).not.toContain("Done Two");
        expect(text).toContain("Pending One");
    });

    it("shows a distinct message (not the generic 'no tasks') when every task is hidden", async () => {
        const tasks = [makeTask({ id: "done-1", isCompleted: true })];
        getTasksForDate.mockResolvedValue(tasks);

        const { text } = await buildTasksDashboard("2026-09-17", 0, true);

        expect(text).not.toContain("No tasks for this date");
        expect(text).toMatch(/hidden/i);
    });

    it("paginates over the post-toggle list, not the full day's list", async () => {
        // 3 completed + 10 pending, PAGE_SIZE 8: with completed hidden there
        // are only 10 visible tasks (2 pages), not 13 (still 2 pages, but a
        // wrong implementation counting allTasks could show stale contents).
        const tasks = [
            ...Array.from({ length: 3 }, (_, i) => makeTask({ id: `done-${i}`, isCompleted: true, fullName: `Done${i} Staff${i}` })),
            ...Array.from({ length: 10 }, (_, i) => makeTask({ id: `pending-${i}`, isCompleted: false, fullName: `Pending${i} Staff${i}` })),
        ];
        getTasksForDate.mockResolvedValue(tasks);

        const page0 = await buildTasksDashboard("2026-09-17", 0, true);
        for (let i = 0; i < 8; i++) expect(page0.text).toContain(`Pending${i}`);
        expect(page0.text).not.toContain("Pending8");

        const page1 = await buildTasksDashboard("2026-09-17", 1, true);
        expect(page1.text).toContain("Pending8");
        expect(page1.text).toContain("Pending9");
    });

    it("labels the toggle button by the CURRENT mode and flips it in the callback data", async () => {
        const tasks = [makeTask({ id: "t-1" })];
        getTasksForDate.mockResolvedValue(tasks);

        const shown = await buildTasksDashboard("2026-09-17", 0, false);
        const shownButtons = shown.keyboard.inline_keyboard.flat();
        const hideButton = shownButtons.find((b: any) => "callback_data" in b && b.callback_data.startsWith("task_hide_"));
        expect(hideButton).toBeDefined();
        expect((hideButton as any).text).toMatch(/hide/i);
        expect((hideButton as any).callback_data).toBe("task_hide_2026-09-17_0_1");

        const hidden = await buildTasksDashboard("2026-09-17", 0, true);
        const hiddenButtons = hidden.keyboard.inline_keyboard.flat();
        const showButton = hiddenButtons.find((b: any) => "callback_data" in b && b.callback_data.startsWith("task_hide_"));
        expect(showButton).toBeDefined();
        expect((showButton as any).text).toMatch(/show/i);
        expect((showButton as any).callback_data).toBe("task_hide_2026-09-17_0_0");
    });

    it("carries the page and hide-mode through every task detail button's callback_data", async () => {
        // 9 tasks so page 1 (the second page, PAGE_SIZE 8) actually has a row.
        const tasks = Array.from({ length: 9 }, (_, i) => makeTask({ id: `task-${i}`, fullName: `Staff${i} Last${i}` }));
        getTasksForDate.mockResolvedValue(tasks);

        const { keyboard } = await buildTasksDashboard("2026-09-17", 1, true);
        const buttons = keyboard.inline_keyboard.flat();
        const detailButton = buttons.find((b: any) => "callback_data" in b && b.callback_data.startsWith("task_det_"));

        expect(detailButton).toBeDefined();
        expect((detailButton as any).callback_data).toBe("task_det_task-8_2026-09-17_1_1");
    });
});
