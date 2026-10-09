import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const redisMock = {
    set: vi.fn(),
    del: vi.fn()
};

const awsBusinessClient = {
    shootsToday: vi.fn()
};

vi.mock("../../repositories/work-shift-repository.js", () => ({ workShiftRepository }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient }));
vi.mock("../replacement-service.js", () => ({ replacementService }));
vi.mock("../task-service.js", () => ({ taskService }));
vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../../core/redis.js", () => ({ redis: redisMock }));
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
        redisMock.set.mockResolvedValue("OK");
        redisMock.del.mockResolvedValue(1);
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "1970-01-01", items: [], invalidCount: 0 });
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

    it("does not send the same shift reminder twice across scheduler instances", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([{
            id: "shift-deduped",
            staffId: "staff-1",
            locationId: "location-1",
            date: new Date(),
            staff: {
                id: "staff-1",
                fullName: "Вікторія <Admin>",
                user: { telegramId: 1311338839n }
            },
            location: { id: "location-1", name: "Park & <Hall>" }
        }]);
        redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");

        await sendDailyShiftReminders({ api: { sendMessage } } as any);
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage.mock.calls[0]?.[1]).toContain("Park &amp; &lt;Hall&gt;");
        expect(sendMessage.mock.calls[0]?.[1]).not.toContain("<Admin>");
    });
});

/**
 * Планувальник жив у памʼяті процесу: одноразовий `setTimeout` на 08:00, а після
 * спрацювання — на 08:00 наступного дня. Будь-який рестарт бота між 08:00 і
 * північчю означав, що нагадування за ЦЕЙ день не піде вже ніколи — не одне, а
 * всі. Це не гіпотеза: 20.08.2026 було три деплої, і кожен переставляв запуск на
 * завтра (`nextRunAt` у логах).
 *
 * AWS цього й не обіцяє: при in-place деплої застосунок зупиняється, а на одному
 * інстансі гарантії доступності немає взагалі.
 *
 * Лікується не окремим catch-up, а заміною одноразового таймера на періодичну
 * перевірку: «чи настало вікно і чи вже зроблено». Дедуплікація вже є —
 * `SET NX` на ключі `shift-reminder:<дата>:<staff>:<shift>` з TTL 3 доби, — тож
 * зайвий прогін нікого не продублює. Саме такої ідемпотентності вимагає й AWS
 * від цілей планувальника: EventBridge Scheduler дає at-least-once.
 */
describe("shift reminder catch-up after a restart", () => {
    it("reports the window as due when the bot starts after 08:00 on the same day", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        // 10:30 Київ — вікно сьогодні вже настало.
        expect(isShiftReminderDue(new Date("2026-07-19T07:30:00.000Z"))).toBe(true);
    });

    it("reports the window as not due before 08:00", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        // 07:59 Київ — ще рано.
        expect(isShiftReminderDue(new Date("2026-07-19T04:59:00.000Z"))).toBe(false);
    });

    it("treats exactly 08:00 as due", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        expect(isShiftReminderDue(new Date("2026-07-19T05:00:00.000Z"))).toBe(true);
    });

    /**
     * Взимку Київ — UTC+2, влітку UTC+3. Вікно прибите до місцевих 08:00, а не до
     * фіксованого UTC, інакше пів року нагадування ходили б на годину не туди.
     */
    it("keeps the window at 08:00 Kyiv across daylight saving", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        expect(isShiftReminderDue(new Date("2026-01-19T05:59:00.000Z"))).toBe(false);
        expect(isShiftReminderDue(new Date("2026-01-19T06:00:00.000Z"))).toBe(true);
    });

    /**
     * Головна перевірка: другий прогін у той самий день нікого не турбує. Redis
     * повертає не-OK на вже зайнятий ключ, і повідомлення не йде.
     */
    it("sends nothing on a second run for a day already handled", async () => {
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        // Зміна на сьогодні є — інакше перевірка проходила б і без дедуплікації,
        // просто тому що розсилати нічого.
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
        // Ключ уже зайнятий першим прогоном — Redis відповідає не-OK.
        redisMock.set.mockResolvedValue(null);

        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).not.toHaveBeenCalled();
    });

    /**
     * Дзеркальна перевірка до попередньої: з тією самою зміною, але вільним
     * ключем нагадування таки йде. Без неї попередній тест не відрізняв би
     * «дедуплікація спрацювала» від «розсилка зламана назовсім».
     */
    it("still sends when the day has not been handled yet", async () => {
        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        const sendMessage = vi.fn().mockResolvedValue(undefined);
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
        redisMock.set.mockResolvedValue("OK");

        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalled();
    });
});

/**
 * Наздоганяння обмежене в часі. Текст каже «Сьогодні у тебе зміна», а зміни
 * закінчуються о 21:00: розсилка о 20:00 повідомляла б про те, що вже минуло.
 * Опівдні ще корисно, ввечері — гірше за мовчання.
 */
describe("shift reminder catch-up window has an end", () => {
    it("still catches up at noon", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        expect(isShiftReminderDue(new Date("2026-07-19T09:00:00.000Z"))).toBe(true);
    });

    it("stops catching up once the shift day is mostly gone", async () => {
        const { isShiftReminderDue } = await import("../shift-reminder-service.js");

        // 17:00 Київ — зміни ще тривають, але нагадувати про початок дня пізно.
        expect(isShiftReminderDue(new Date("2026-07-19T14:00:00.000Z"))).toBe(false);
    });
});

/** Строка «🎂 19:00–20:00 — зйомка ДН»: у нагадуванні про зміну, а без зміни — окреме повідомлення. */
describe("shoot of the day", () => {
    const LEOLAND = "4dbbaf0a-3c37-4e20-845b-8baa0217149b";
    const shoot = (overrides: Record<string, unknown> = {}) => ({
        telegramId: "144952810",
        firstName: "Анастасія",
        intervals: [{ start: "19:00", end: "20:00" }],
        location: { publicId: LEOLAND, name: "Leoland", city: "Lviv", branch: null },
        ...overrides
    });
    const shift = (awsPublicId: string) => ({
        id: "shift-1",
        staffId: "staff-1",
        locationId: "location-1",
        date: new Date("2026-10-10T00:00:00.000Z"),
        staff: { id: "staff-1", fullName: "Амброскіна Анастасія", user: { telegramId: 144952810n } },
        location: { id: "location-1", name: "Leoland", city: "Lviv", awsPublicId }
    });

    beforeEach(() => {
        vi.clearAllMocks();
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([]);
        replacementService.listAcceptedAssignmentsByDateRange.mockResolvedValue([]);
        taskService.getStaffActiveTasks.mockResolvedValue([]);
        prismaMock.parcel.count.mockResolvedValue(0);
        redisMock.set.mockResolvedValue("OK");
        redisMock.del.mockResolvedValue(1);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-10T05:00:00.000Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("adds the shoot line to the shift reminder without repeating the shift location", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([shift(LEOLAND)]);
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-10", items: [shoot()], invalidCount: 0 });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        const text = sendMessage.mock.calls[0]?.[1] as string;
        expect(text).toContain("Вдалого дня та гарних знімків! ✨\n\n🎂 19:00–20:00 — зйомка ДН");
        expect(text).not.toContain("📍");
    });

    it("names the shoot location when it is not where the shift is", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([
            shift("0f8fad5b-d9cb-469f-a165-70867728950e")
        ]);
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-10", items: [shoot()], invalidCount: 0 });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage.mock.calls[0]?.[1]).toContain("🎂 19:00–20:00 — зйомка ДН\n📍 Leoland (Lviv)");
    });

    it("sends a separate morning message when there is a shoot but no shift", async () => {
        awsBusinessClient.shootsToday.mockResolvedValue({
            date: "2026-10-10",
            items: [shoot({ intervals: [{ start: "11:30", end: "13:00" }] }), shoot()],
            invalidCount: 0
        });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith(
            144952810,
            "👋 <b>Доброго ранку, Анастасія!</b>\n\n" +
                "🎂 11:30–13:00 — зйомка ДН\n📍 Leoland (Lviv)\n" +
                "🎂 19:00–20:00 — зйомка ДН\n📍 Leoland (Lviv)",
            { parse_mode: "HTML" }
        );
        expect(redisMock.set).toHaveBeenCalledWith("shoot-today:2026-10-10:144952810", "sending", "EX", expect.any(Number), "NX");
    });

    it("does not send the shoot-only message twice in one day", async () => {
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-10", items: [shoot()], invalidCount: 0 });
        redisMock.set.mockResolvedValue(null);
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("releases the shoot-only claim when Telegram refuses, so the next run retries", async () => {
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-10", items: [shoot()], invalidCount: 0 });
        const sendMessage = vi.fn().mockRejectedValue(new Error("Too Many Requests"));

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(redisMock.del).toHaveBeenCalledWith("shoot-today:2026-10-10:144952810");
    });

    it("still sends the shift reminder when the webapp is unavailable", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([shift(LEOLAND)]);
        awsBusinessClient.shootsToday.mockRejectedValue(new Error("ECONNREFUSED"));
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[1]).not.toContain("🎂");
    });

    it("ignores an answer for another day", async () => {
        workShiftRepository.findWithRelationsByDateRange.mockResolvedValue([shift(LEOLAND)]);
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-11", items: [shoot()], invalidCount: 0 });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[1]).not.toContain("🎂");
    });

    it("a shoot without a start time is still named", async () => {
        awsBusinessClient.shootsToday.mockResolvedValue({ date: "2026-10-10", items: [shoot({ intervals: [] })], invalidCount: 0 });
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        const { sendDailyShiftReminders } = await import("../shift-reminder-service.js");
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(sendMessage.mock.calls[0]?.[1]).toContain("🎂 Зйомка ДН\n📍 Leoland (Lviv)");
    });
});
