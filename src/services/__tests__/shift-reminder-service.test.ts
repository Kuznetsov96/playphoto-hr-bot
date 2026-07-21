import { beforeEach, describe, expect, it, vi } from "vitest";

const workShiftRepository = {
    findWithRelationsByDateRange: vi.fn()
};

const replacementService = {
    listAcceptedAssignmentsByDateRange: vi.fn()
};

const taskService = {
    getStaffActiveTasks: vi.fn()
};

const prismaMock = {
    parcel: {
        count: vi.fn()
    }
};

vi.mock("../../repositories/work-shift-repository.js", () => ({ workShiftRepository }));
vi.mock("../replacement-service.js", () => ({ replacementService }));
vi.mock("../task-service.js", () => ({ taskService }));
vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

describe("shift reminder service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([]);
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([]);
        taskService.getStaffActiveTasks.mockResolvedValue([]);
        prismaMock.parcel.count.mockResolvedValue(0);
    });

    it("schedules 08:00 Kyiv correctly in summer and winter", async () => {
        const { getNextShiftReminderAt } = await import("../shift-reminder-service.js");

        expect(getNextShiftReminderAt(new Date("2026-07-19T04:00:00.000Z")).toISOString())
            .toBe("2026-07-19T05:00:00.000Z");
        expect(getNextShiftReminderAt(new Date("2026-07-19T05:00:01.000Z")).toISOString())
            .toBe("2026-07-20T05:00:00.000Z");
        expect(getNextShiftReminderAt(new Date("2026-01-19T04:00:00.000Z")).toISOString())
            .toBe("2026-01-19T06:00:00.000Z");
    });

    it("reminds about an accepted replacement before the main schedule is synchronized", async () => {
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([
            {
                id: "replacement-1",
                requesterStaffId: "original-staff",
                replacementStaffId: "staff-1",
                locationId: "location-1",
                shiftDate: new Date("2026-07-19T00:00:00.000Z"),
                shiftStartTime: new Date("2026-07-19T09:00:00.000Z"),
                shiftEndTime: new Date("2026-07-19T18:00:00.000Z"),
                replacement: {
                    id: "staff-1",
                    fullName: "Виниченко Вікторія",
                    user: { telegramId: 1311338839n }
                },
                location: {
                    id: "location-1",
                    name: "Volkland 3 (Перемоги)",
                    schedule: "12:00-21:00"
                }
            }
        ]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const bot = { api: { sendMessage } };

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders(bot as any);

        expect(sendMessage).toHaveBeenCalledWith(
            1311338839,
            expect.stringContaining("Підміну підтверджено. Основний графік ще синхронізується."),
            expect.objectContaining({
                parse_mode: "HTML",
                reply_markup: expect.anything()
            })
        );
        expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("disable_notification");
    });

    it("does not duplicate a reminder when the accepted replacement is already in the main schedule", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([
            {
                id: "shift-1",
                staffId: "staff-1",
                locationId: "location-1",
                date: new Date("2026-07-19T00:00:00.000Z"),
                staff: {
                    id: "staff-1",
                    fullName: "Виниченко Вікторія",
                    user: { telegramId: 1311338839n }
                },
                location: { id: "location-1", name: "Volkland 3 (Перемоги)" }
            }
        ]);
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([
            {
                id: "replacement-1",
                requesterStaffId: "original-staff",
                replacementStaffId: "staff-1",
                locationId: "location-1",
                shiftDate: new Date("2026-07-19T00:00:00.000Z"),
                replacement: {
                    id: "staff-1",
                    fullName: "Виниченко Вікторія",
                    user: { telegramId: 1311338839n }
                },
                location: { id: "location-1", name: "Volkland 3 (Перемоги)" }
            }
        ]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[1]).not.toContain("Основний графік ще синхронізується");
    });

    it("uses a third-person schedule update instead of a stale accepted replacement", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([{
            id: "shift-third-person",
            staffId: "third-staff",
            locationId: "location-1",
            date: new Date("2026-07-21T00:00:00.000Z"),
            staff: {
                id: "third-staff",
                fullName: "Гут Ольга",
                user: { telegramId: 222222222n }
            },
            location: { id: "location-1", name: "Dragon Park" }
        }]);
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([{
            id: "replacement-stale",
            requesterStaffId: "original-staff",
            replacementStaffId: "replacement-staff",
            locationId: "location-1",
            shiftDate: new Date("2026-07-21T00:00:00.000Z"),
            shiftStartTime: null,
            shiftEndTime: null,
            replacement: {
                id: "replacement-staff",
                fullName: "Зубаль Діана",
                user: { telegramId: 111111111n }
            },
            location: { id: "location-1", name: "Dragon Park" }
        }]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith(
            222222222,
            expect.stringContaining("Dragon Park"),
            expect.anything()
        );
    });

    it("replaces the original photographer reminder while an accepted assignment is pending sync", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([{
            id: "shift-original",
            staffId: "original-staff",
            locationId: "location-1",
            date: new Date("2026-07-21T00:00:00.000Z"),
            staff: {
                id: "original-staff",
                fullName: "Бланк Анастасія",
                user: { telegramId: 222222222n }
            },
            location: { id: "location-1", name: "Dragon Park" }
        }]);
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([{
            id: "replacement-pending",
            requesterStaffId: "original-staff",
            replacementStaffId: "replacement-staff",
            locationId: "location-1",
            shiftDate: new Date("2026-07-21T00:00:00.000Z"),
            shiftStartTime: null,
            shiftEndTime: null,
            replacement: {
                id: "replacement-staff",
                fullName: "Зубаль Діана",
                user: { telegramId: 111111111n }
            },
            location: { id: "location-1", name: "Dragon Park" }
        }]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith(
            111111111,
            expect.stringContaining("Основний графік ще синхронізується"),
            expect.anything()
        );
    });
});
