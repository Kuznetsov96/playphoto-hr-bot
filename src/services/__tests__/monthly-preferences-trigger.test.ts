import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBroadcast = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();
const schedulePreferenceSchedule = vi.fn();

vi.mock("../broadcast.js", () => ({ broadcastService: { createBroadcast } }));
vi.mock("../../core/redis.js", () => ({ redis: { set: redisSet, del: redisDel } }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { schedulePreferenceSchedule } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { MonthlyPreferencesTrigger } = await import("../monthly-preferences-trigger.js");

const bot = { api: {} } as any;
const openNovember = {
    month: "2026-11",
    open: true,
    deadline: "2026-10-26",
    deadlineEndsAt: "2026-10-26T22:00:00.000Z",
};

/**
 * Рассылка 23-го. Срок приходит из вебаппа; своего числа у бота нет. Проверяется
 * то, что может сорвать рассылку месяца: лежащий вебапп, поздний выкат, повтор.
 */
describe("monthly preferences invite", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-23T07:30:00Z")); // 23.10, 10:30 Київ
        redisSet.mockResolvedValue("OK");
        redisDel.mockResolvedValue(1);
        createBroadcast.mockResolvedValue(40);
        schedulePreferenceSchedule.mockResolvedValue(openNovember);
    });
    afterEach(() => vi.useRealTimers());

    it("names the deadline from the web app and caps reminders at the month's end", async () => {
        schedulePreferenceSchedule.mockResolvedValue({ ...openNovember, deadline: "2026-10-28", deadlineEndsAt: "2026-10-28T22:00:00.000Z" });

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(schedulePreferenceSchedule).toHaveBeenCalledWith("2026-11");
        const [, , text, , , , options] = createBroadcast.mock.calls[0]!;
        expect(text).toContain("до 28 жовтня, середа");
        expect(options).toMatchObject({ buttonType: "preferences", targetMonth: "2026-11" });
        expect((options.pingUntil as Date).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    });

    /** Вебапп лежит — ни угаданной даты, ни потерянного месяца: ключ освобождается, повтор. */
    it("sends nothing and frees the month key when the web app is down", async () => {
        schedulePreferenceSchedule.mockRejectedValue(new Error("timeout"));

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(createBroadcast).not.toHaveBeenCalled();
        expect(redisDel).toHaveBeenCalledWith("monthly_pref_triggered:2026-10");
    });

    /** Лежал весь 23-й — рассылка уходит 24-го, а не пропадает на месяц. */
    it("still tries on the 24th", async () => {
        vi.setSystemTime(new Date("2026-10-24T07:30:00Z"));

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(createBroadcast).toHaveBeenCalledTimes(1);
    });

    it("does nothing before the 23rd or before 10:00", async () => {
        vi.setSystemTime(new Date("2026-10-22T09:00:00Z"));
        await MonthlyPreferencesTrigger.checkAndTrigger(bot);
        vi.setSystemTime(new Date("2026-10-23T05:00:00Z")); // 08:00 Київ
        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(redisSet).not.toHaveBeenCalled();
        expect(createBroadcast).not.toHaveBeenCalled();
    });

    /** Выкат после срока с пустым Redis не должен разослать приглашение заново. */
    it("does not invite once the deadline has passed", async () => {
        vi.setSystemTime(new Date("2026-10-27T08:00:00Z"));

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(createBroadcast).not.toHaveBeenCalled();
        expect(redisDel).not.toHaveBeenCalled();
    });

    it("does not invite into a collection the owner already closed", async () => {
        schedulePreferenceSchedule.mockResolvedValue({ ...openNovember, open: false });

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(createBroadcast).not.toHaveBeenCalled();
    });

    it("sends once a month: the key is already taken", async () => {
        redisSet.mockResolvedValue(null);

        await MonthlyPreferencesTrigger.checkAndTrigger(bot);

        expect(schedulePreferenceSchedule).not.toHaveBeenCalled();
        expect(createBroadcast).not.toHaveBeenCalled();
    });
});
