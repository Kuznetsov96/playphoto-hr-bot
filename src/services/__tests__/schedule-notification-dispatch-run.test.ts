import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = {
    set: vi.fn(),
    eval: vi.fn()
};

const awsBusinessClientMock = {
    pendingScheduleNotifications: vi.fn(),
    markScheduleNotificationDelivered: vi.fn(),
    markScheduleNotificationFailed: vi.fn()
};

vi.mock("../../core/redis.js", () => ({ redis: redisMock, default: redisMock }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: awsBusinessClientMock }));

const urgentNotification = {
    publicId: "n-1",
    employeePublicId: "e-1",
    telegramId: "100",
    changeKind: "SHIFT_MOVED" as const,
    urgency: "URGENT" as const,
    batchId: null,
    payload: { after: { date: "11.08", time: "12:00-20:00", location: "Гулівер" } }
};

describe("ScheduleNotificationDispatcher.runOnce", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisMock.set.mockResolvedValue("OK");
        redisMock.eval.mockResolvedValue(1);
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue([]);
        awsBusinessClientMock.markScheduleNotificationDelivered.mockResolvedValue(undefined);
        awsBusinessClientMock.markScheduleNotificationFailed.mockResolvedValue(undefined);
    });

    it("sends nothing when another bot instance owns the lease", async () => {
        redisMock.set.mockResolvedValue(null);
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue([urgentNotification]);
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn();

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(awsBusinessClientMock.pendingScheduleNotifications).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("acquires the lease with NX and a TTL, then releases it with a token-checked script", async () => {
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage: vi.fn() });

        expect(redisMock.set).toHaveBeenCalledWith(
            "worker:schedule-notification-dispatcher:lease",
            expect.any(String),
            "PX",
            expect.any(Number),
            "NX"
        );
        expect(redisMock.eval).toHaveBeenCalledWith(
            expect.stringContaining("redis.call('del', KEYS[1])"),
            1,
            "worker:schedule-notification-dispatcher:lease",
            expect.any(String)
        );
    });

    it("reports delivered once per notification after a successful send", async () => {
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue([
            { ...urgentNotification, publicId: "a", urgency: "NORMAL" as const, batchId: "b1" },
            { ...urgentNotification, publicId: "b", urgency: "NORMAL" as const, batchId: "b1" }
        ]);
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith(100, expect.any(String), expect.objectContaining({
            parse_mode: "HTML"
        }));
        expect(awsBusinessClientMock.markScheduleNotificationDelivered.mock.calls.map(call => call[0]))
            .toEqual(["a", "b"]);
        expect(awsBusinessClientMock.markScheduleNotificationFailed).not.toHaveBeenCalled();
    });

    it("reports a safe non-PII reason when the Telegram send fails", async () => {
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue([urgentNotification]);
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn().mockRejectedValue(
            new Error("Forbidden: bot was blocked by Олена +380671234567")
        );

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(awsBusinessClientMock.markScheduleNotificationDelivered).not.toHaveBeenCalled();
        expect(awsBusinessClientMock.markScheduleNotificationFailed)
            .toHaveBeenCalledWith("n-1", "TELEGRAM_RECIPIENT_UNREACHABLE");
    });

    it("still releases the lease when fetching pending notifications throws", async () => {
        awsBusinessClientMock.pendingScheduleNotifications.mockRejectedValue(new Error("upstream down"));
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");

        await expect(new ScheduleNotificationDispatcher().runOnce({ sendMessage: vi.fn() }))
            .resolves.toBeUndefined();
        expect(redisMock.eval).toHaveBeenCalledWith(
            expect.stringContaining("redis.call('del', KEYS[1])"),
            1,
            "worker:schedule-notification-dispatcher:lease",
            expect.any(String)
        );
    });

    it("skips an overlapping local iteration on the same instance", async () => {
        let releasePending: (value: unknown[]) => void = () => { };
        awsBusinessClientMock.pendingScheduleNotifications.mockReturnValue(
            new Promise(resolve => { releasePending = resolve; })
        );
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const dispatcher = new ScheduleNotificationDispatcher();

        const first = dispatcher.runOnce({ sendMessage: vi.fn() });
        await dispatcher.runOnce({ sendMessage: vi.fn() });

        expect(redisMock.set).toHaveBeenCalledTimes(1);
        releasePending([]);
        await first;
    });
});
