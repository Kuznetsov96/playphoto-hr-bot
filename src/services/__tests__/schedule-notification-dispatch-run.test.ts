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

/** Mirrors the backend's ScheduleNotificationShiftSnapshot contract. */
const shiftSnapshot = {
    startsAtLocal: "2026-08-11T12:00:00",
    endsAtLocal: "2026-08-11T20:00:00",
    timezone: "Europe/Kyiv",
    locationPublicId: "11111111-1111-4111-8111-111111111111",
    locationName: "Гулівер",
    locationCity: "Київ"
};

const urgentNotification = {
    publicId: "n-1",
    employeePublicId: "e-1",
    telegramId: "100",
    changeKind: "SHIFT_MOVED" as const,
    urgency: "URGENT" as const,
    batchId: null,
    payload: { after: shiftSnapshot }
};

/** The client's fetch result: valid rows, plus rows it rejected as malformed. */
function pendingResult(
    items: unknown[],
    invalidPublicIds: string[] = [],
    unidentifiableCount = 0
) {
    return { items, invalidPublicIds, unidentifiableCount };
}

describe("ScheduleNotificationDispatcher.runOnce", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisMock.set.mockResolvedValue("OK");
        redisMock.eval.mockResolvedValue(1);
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult([]));
        awsBusinessClientMock.markScheduleNotificationDelivered.mockResolvedValue(undefined);
        awsBusinessClientMock.markScheduleNotificationFailed.mockResolvedValue(undefined);
    });

    it("sends nothing when another bot instance owns the lease", async () => {
        redisMock.set.mockResolvedValue(null);
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult([urgentNotification]));
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
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult([
            { ...urgentNotification, publicId: "a", urgency: "NORMAL" as const, batchId: "b1" },
            { ...urgentNotification, publicId: "b", urgency: "NORMAL" as const, batchId: "b1" }
        ]));
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

    /**
     * Three Zaporizhzhia venues are all named "Volkland" and differ only by branch, so a schedule
     * change that does not name it leaves the photographer unable to tell which shift moved.
     */
    it("names the branch that tells same-named venues apart", async () => {
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult([{
            ...urgentNotification,
            payload: {
                after: {
                    ...shiftSnapshot,
                    locationName: "Volkland",
                    locationBranch: "Шевчик",
                    locationCity: "Запоріжжя",
                },
            },
        }]));
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(sendMessage.mock.calls[0]![1]).toContain("Volkland (Шевчик)");
    });

    it("reports a safe non-PII reason when the Telegram send fails", async () => {
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult([urgentNotification]));
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
        let releasePending: (value: ReturnType<typeof pendingResult>) => void = () => { };
        awsBusinessClientMock.pendingScheduleNotifications.mockReturnValue(
            new Promise(resolve => { releasePending = resolve; })
        );
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const dispatcher = new ScheduleNotificationDispatcher();

        const first = dispatcher.runOnce({ sendMessage: vi.fn() });
        await dispatcher.runOnce({ sendMessage: vi.fn() });

        expect(redisMock.set).toHaveBeenCalledTimes(1);
        releasePending(pendingResult([]));
        await first;
    });

    it("delivers the good rows and reports only the malformed one", async () => {
        // The reported failure mode: one bad payload used to throw during the
        // array-wide parse, so the catch-all abandoned the entire pass and every
        // other photographer's notification went undelivered with it.
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(pendingResult(
            [
                { ...urgentNotification, publicId: "good-1", urgency: "NORMAL" as const, batchId: "b1" },
                { ...urgentNotification, publicId: "good-2", urgency: "NORMAL" as const, batchId: "b1" }
            ],
            ["bad-1"]
        ));
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(awsBusinessClientMock.markScheduleNotificationDelivered.mock.calls.map(call => call[0]))
            .toEqual(["good-1", "good-2"]);
        expect(awsBusinessClientMock.markScheduleNotificationFailed)
            .toHaveBeenCalledWith("bad-1", "SCHEDULE_NOTIFICATION_PAYLOAD_INVALID");
        expect(awsBusinessClientMock.markScheduleNotificationFailed).toHaveBeenCalledTimes(1);
    });

    it("still completes the pass when a malformed row cannot even be identified", async () => {
        // A row without a usable publicId cannot be reported, but it must not
        // stop the rows that can be delivered.
        awsBusinessClientMock.pendingScheduleNotifications.mockResolvedValue(
            pendingResult([urgentNotification], [], 1)
        );
        const { ScheduleNotificationDispatcher } = await import("../schedule-notification-dispatcher.js");
        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

        await new ScheduleNotificationDispatcher().runOnce({ sendMessage });

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(awsBusinessClientMock.markScheduleNotificationFailed).not.toHaveBeenCalled();
    });
});
