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

function makeTask(overrides: Partial<{
    id: string;
    isCompleted: boolean;
    deadlineTime: string | null;
    city: string;
    locationName: string;
    fullName: string;
}> = {}) {
    const id = overrides.id ?? `task-${Math.random().toString(36).slice(2)}`;
    return {
        id,
        isCompleted: overrides.isCompleted ?? false,
        deadlineTime: overrides.deadlineTime ?? null,
        city: overrides.city ?? "Kyiv",
        locationName: overrides.locationName ?? "Podil",
        taskText: "Do the thing",
        workDate: new Date("2026-09-17T00:00:00.000Z"),
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
            ...Array.from({ length: 3 }, (_, i) => makeTask({ id: `urgent-${i}`, deadlineTime: "18:00", fullName: `Urgent${i} Staff${i}` })),
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
        }));
        getTasksForDate.mockResolvedValue(tasks);

        for (let page = 0; page < 8; page++) {
            const { text } = await buildTasksDashboard("2026-09-17", page);
            expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
        }
    });
});
