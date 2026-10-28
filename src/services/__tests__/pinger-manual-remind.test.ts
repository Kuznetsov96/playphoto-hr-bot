import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findToPing = vi.fn();
const findForManualRemind = vi.fn();
const trackedUpdate = vi.fn();
const findDue = vi.fn();
const broadcastUpdate = vi.fn();
const pingLogCreate = vi.fn().mockResolvedValue({});
const enqueueSync = vi.fn().mockResolvedValue(undefined);
const processSync = vi.fn().mockResolvedValue(undefined);
const reminderState = vi.fn();
const bumpAttempts = vi.fn();
const attempts = new Map<string, number>();

// Память вместо таблиц BroadcastActionLog / BroadcastReminderMark.
const marks = new Set<string>();
const logs = new Map<string, string>();

vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: enqueueSync, processAnnouncementSync: processSync }));
vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: { findToPing, findForManualRemind, update: trackedUpdate, stopTracking: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { findDueManualReminders: findDue, update: broadcastUpdate, findReminderState: reminderState },
}));
vi.mock("../../repositories/broadcast-action-repository.js", () => ({
    broadcastActionRepository: {
        findLog: vi.fn(async (id: string) => (logs.has(id) ? { publicId: id } : null)),
        markDone: vi.fn(async (id: string, _b: number, kind: string) => { logs.set(id, kind); }),
        claimReminderMark: vi.fn(async (_b: number, chatId: bigint, action: string) => {
            const key = `${action}:${chatId}`;
            if (marks.has(key)) return false;
            marks.add(key);
            return true;
        }),
        bumpAttempts: bumpAttempts,
        releaseReminderMark: vi.fn(async (chatId: bigint, action: string) => { marks.delete(`${action}:${chatId}`); }),
    },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: { updateMany: vi.fn() } }));
vi.mock("../../repositories/broadcast-ping-log-repository.js", () => ({ broadcastPingLogRepository: { create: pingLogCreate } }));
vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
const schedulePreferenceSchedule = vi.fn();
const scheduleNull = () => schedulePreferenceSchedule.mockRejectedValue(new Error("down"));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { schedulePreferenceSchedule } }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../schedule-sync.js", () => ({ scheduleSyncService: {} }));
vi.mock("../../utils/bot-blocked.js", () => ({ handleBlockedCandidate: vi.fn() }));
vi.mock("../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logSecurityEvent: vi.fn() }));

const { runPingerForTest, remindBroadcast } = await import("../pinger.js");

const ACTION = "33333333-3333-4333-8333-333333333333";

const tracked = (chatId: number, pending: number) => ({
    id: chatId,
    chatId,
    messageId: chatId + 1000,
    lastPingMsgId: null,
    pingIntervalMs: null,
    broadcastId: 7,
    buttonType: "default",
    targetMonth: null,
    pingUntil: null,
    broadcast: { id: 7 },
    pendingReplies: Array.from({ length: pending }, (_, i) => ({ id: i, userId: BigInt(chatId), status: "pending", user: { telegramId: BigInt(chatId) } })),
});

const bot = () => ({
    api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 900 }),
        deleteMessage: vi.fn().mockResolvedValue(true),
        getChatMember: vi.fn(),
    },
}) as any;

beforeEach(() => {
    vi.clearAllMocks();
    marks.clear();
    logs.clear();
    attempts.clear();
    reminderState.mockResolvedValue({ withdrawnAt: null, remindersStoppedAt: null });
    bumpAttempts.mockImplementation(async (_b: number, action: string) => {
        attempts.set(action, (attempts.get(action) ?? 0) + 1);
        return attempts.get(action)!;
    });
    findToPing.mockResolvedValue([]);
    findDue.mockResolvedValue([]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-27T11:00:00Z")); // 13:00 Киев
});
afterEach(() => vi.useRealTimers());

describe("manual reminder", () => {
    it("sends one reminder to each chat with pending answers only, and never touches nextPingAt", async () => {
        findForManualRemind.mockResolvedValue([tracked(10, 1), tracked(20, 0), tracked(30, 2)]);
        const b = bot();

        const result = await remindBroadcast(b, 7, ACTION);

        expect(result).toEqual({ sent: 2, failed: 0 });
        expect(b.api.sendMessage.mock.calls.map((c: any[]) => c[0])).toEqual([10, 30]);
        // Только lastPingMsgId: рассылка без автонапоминаний сама напоминать не начинает.
        for (const call of trackedUpdate.mock.calls) expect(call[1]).toEqual({ lastPingMsgId: 900 });
        expect(pingLogCreate).toHaveBeenCalledWith(7, 10n, { messageId: 900, actorName: null });
        expect(pingLogCreate).toHaveBeenCalledWith(7, 30n, { messageId: 900, actorName: null });
    });

    it("a repeated action never sends a second reminder to the same chat", async () => {
        findForManualRemind.mockResolvedValue([tracked(10, 1), tracked(30, 1)]);
        const b = bot();

        await remindBroadcast(b, 7, ACTION);
        const again = await remindBroadcast(b, 7, ACTION);

        expect(again).toEqual({ sent: 0, failed: 0 });
        expect(b.api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("after a partial send only the missed chat gets the retry; a failed chat keeps no mark", async () => {
        findForManualRemind.mockResolvedValue([tracked(10, 1), tracked(30, 1)]);
        const b = bot();
        b.api.sendMessage
            .mockResolvedValueOnce({ message_id: 1 })
            .mockRejectedValueOnce({ error_code: 500, description: "boom" });

        const first = await remindBroadcast(b, 7, ACTION);
        const second = await remindBroadcast(b, 7, ACTION);

        expect(first).toEqual({ sent: 1, failed: 1 });
        expect(second).toEqual({ sent: 1, failed: 0 });
        expect(b.api.sendMessage.mock.calls.map((c: any[]) => c[0])).toEqual([10, 30, 30]);
    });

    it("night: the tick does nothing at 23:10 Kyiv, sends at 10:00 and not again on the next tick", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: null, withdrawnAt: null, remindersStoppedAt: null }]);
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const b = bot();

        vi.setSystemTime(new Date("2026-10-27T21:10:00Z")); // 23:10 Киев (UTC+2), тихие часы
        await runPingerForTest(b);
        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(broadcastUpdate).not.toHaveBeenCalled();

        vi.setSystemTime(new Date("2026-10-28T08:00:00Z")); // 10:00 Киев
        await runPingerForTest(b);
        expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
        expect(logs.get(ACTION)).toBe("REMIND");

        // Строка ещё «просрочена» (гонка двух тиков): действие закрыто журналом, второго сообщения нет.
        vi.setSystemTime(new Date("2026-10-28T08:01:00Z"));
        await runPingerForTest(b);
        expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a deferred reminder does not fire after reminders were stopped, but the action is closed", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: null, withdrawnAt: null, remindersStoppedAt: new Date() }]);
        const b = bot();

        await runPingerForTest(b);

        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(logs.get(ACTION)).toBe("REMIND");
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
    });

    it("a withdrawn broadcast sends nothing on the deferred tick but the action is closed", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: null, withdrawnAt: new Date(), remindersStoppedAt: null }]);
        const b = bot();

        await runPingerForTest(b);

        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
    });

    it("the action's actorName goes into every ping log of a manual reminder", async () => {
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const b = bot();

        await remindBroadcast(b, 7, ACTION, new Date(), "Olha");

        expect(pingLogCreate).toHaveBeenCalledWith(7, 10n, { messageId: 900, actorName: "Olha" });
    });

    it("sends nothing to a broadcast withdrawn or stopped while the tick was waiting (re-read before sending)", async () => {
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const b = bot();

        reminderState.mockResolvedValueOnce({ withdrawnAt: new Date(), remindersStoppedAt: null });
        expect(await remindBroadcast(b, 7, ACTION)).toEqual({ sent: 0, failed: 0 });
        reminderState.mockResolvedValueOnce({ withdrawnAt: null, remindersStoppedAt: new Date() });
        findToPing.mockResolvedValue([tracked(20, 1)]);
        await runPingerForTest(b);

        expect(b.api.sendMessage).not.toHaveBeenCalled();
    });

    it("auto reminder re-reads the state too and does not send to a withdrawn broadcast", async () => {
        findToPing.mockResolvedValue([tracked(20, 1)]);
        reminderState.mockResolvedValue({ withdrawnAt: new Date(), remindersStoppedAt: null });
        const b = bot();

        await runPingerForTest(b);

        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(pingLogCreate).not.toHaveBeenCalled();
    });

    it("night: a transient failure keeps the deferred reminder for the next tick, then gives up after 3 attempts", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: "Olha", withdrawnAt: null, remindersStoppedAt: null }]);
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const b = bot();
        b.api.sendMessage.mockRejectedValue({ error_code: 500, description: "boom" });

        for (const minute of ["08:00", "08:01"]) {
            vi.setSystemTime(new Date(`2026-10-28T${minute}:00Z`));
            await runPingerForTest(b);
            expect(broadcastUpdate).not.toHaveBeenCalled();
            expect(logs.has(ACTION)).toBe(false);
        }
        vi.setSystemTime(new Date("2026-10-28T08:02:00Z"));
        await runPingerForTest(b);

        expect(b.api.sendMessage).toHaveBeenCalledTimes(3);
        expect(logs.get(ACTION)).toBe("REMIND");
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
    });

    it("night: a chat that failed on the first tick is delivered on the second, and the deferred reminder then closes", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: "Olha", withdrawnAt: null, remindersStoppedAt: null }]);
        findForManualRemind.mockResolvedValue([tracked(10, 1), tracked(30, 1)]);
        const b = bot();
        b.api.sendMessage
            .mockResolvedValueOnce({ message_id: 1 })
            .mockRejectedValueOnce({ error_code: 500, description: "boom" });

        vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
        await runPingerForTest(b);
        expect(logs.has(ACTION)).toBe(false);
        vi.setSystemTime(new Date("2026-10-28T08:01:00Z"));
        await runPingerForTest(b);

        expect(b.api.sendMessage.mock.calls.map((c: any[]) => c[0])).toEqual([10, 30, 30]);
        expect(logs.get(ACTION)).toBe("REMIND");
        expect(pingLogCreate).toHaveBeenCalledWith(7, 30n, { messageId: 900, actorName: "Olha" });
    });

    it("the snapshot of the fired deferred reminder goes out before manualRemindAt is cleared", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, manualRemindActorName: null, withdrawnAt: null, remindersStoppedAt: null }]);
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const order: string[] = [];
        processSync.mockImplementation(async () => { order.push("snapshot"); });
        broadcastUpdate.mockImplementation(async () => { order.push("clear"); });
        vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));

        await runPingerForTest(bot());

        expect(order).toEqual(["snapshot", "clear"]);
        expect(logs.get(ACTION)).toBe("REMIND");
    });

    it("a webapp outage (schedule null) counts as a failed reminder, not a skipped one", async () => {
        const preferences = { ...tracked(10, 1), buttonType: "preferences", targetMonth: "2026-11" };
        findForManualRemind.mockResolvedValue([preferences]);
        scheduleNull();
        const b = bot();

        const result = await remindBroadcast(b, 7, ACTION);

        expect(result).toEqual({ sent: 0, failed: 1 });
        expect(b.api.sendMessage).not.toHaveBeenCalled();
    });
});
