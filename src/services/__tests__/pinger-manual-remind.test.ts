import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findToPing = vi.fn();
const findForManualRemind = vi.fn();
const trackedUpdate = vi.fn();
const findDue = vi.fn();
const broadcastUpdate = vi.fn();
const pingLogCreate = vi.fn().mockResolvedValue({});
const enqueueSync = vi.fn().mockResolvedValue(undefined);

// Память вместо таблиц BroadcastActionLog / BroadcastReminderMark.
const marks = new Set<string>();
const logs = new Map<string, string>();

vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: enqueueSync }));
vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: { findToPing, findForManualRemind, update: trackedUpdate, stopTracking: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { findDueManualReminders: findDue, update: broadcastUpdate },
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
        releaseReminderMark: vi.fn(async (chatId: bigint, action: string) => { marks.delete(`${action}:${chatId}`); }),
    },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: { updateMany: vi.fn() } }));
vi.mock("../../repositories/broadcast-ping-log-repository.js", () => ({ broadcastPingLogRepository: { create: pingLogCreate } }));
vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: {} }));
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
        expect(pingLogCreate).toHaveBeenCalledWith(7, 10n);
        expect(pingLogCreate).toHaveBeenCalledWith(7, 30n);
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
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, withdrawnAt: null, remindersStoppedAt: null }]);
        findForManualRemind.mockResolvedValue([tracked(10, 1)]);
        const b = bot();

        vi.setSystemTime(new Date("2026-10-27T21:10:00Z")); // 23:10 Киев (UTC+2), тихие часы
        await runPingerForTest(b);
        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(broadcastUpdate).not.toHaveBeenCalled();

        vi.setSystemTime(new Date("2026-10-28T08:00:00Z")); // 10:00 Киев
        await runPingerForTest(b);
        expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null });
        expect(logs.get(ACTION)).toBe("REMIND");

        // Строка ещё «просрочена» (гонка двух тиков): действие закрыто журналом, второго сообщения нет.
        vi.setSystemTime(new Date("2026-10-28T08:01:00Z"));
        await runPingerForTest(b);
        expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("a withdrawn broadcast sends nothing on the deferred tick but the action is closed", async () => {
        findDue.mockResolvedValue([{ id: 7, manualRemindActionId: ACTION, withdrawnAt: new Date(), remindersStoppedAt: null }]);
        const b = bot();

        await runPingerForTest(b);

        expect(b.api.sendMessage).not.toHaveBeenCalled();
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: null, manualRemindActionId: null });
    });
});
