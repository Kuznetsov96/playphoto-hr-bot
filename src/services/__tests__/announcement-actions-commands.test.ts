import { beforeEach, describe, expect, it, vi } from "vitest";

const listPending = vi.fn();
const ackAccepted = vi.fn();
const ackFailed = vi.fn();
const findByPublicId = vi.fn();
const broadcastUpdate = vi.fn();
const stopPinging = vi.fn();
const withdrawBroadcast = vi.fn();
const remindBroadcast = vi.fn();
const syncSafe = vi.fn();
const logs = new Map<string, { publicId: string; result: unknown }>();
const markDone = vi.fn(async (id: string, _b: number, _k: string, result?: unknown) => {
    if (!logs.has(id)) logs.set(id, { publicId: id, result: result ?? null });
});
const flag = { enabled: true };

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingAnnouncementCommands: listPending,
        ackAnnouncementCommandAccepted: ackAccepted,
        ackAnnouncementCommandFailed: ackFailed,
    },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { findByPublicId, update: broadcastUpdate },
}));
vi.mock("../../repositories/broadcast-action-repository.js", () => ({
    broadcastActionRepository: { findLog: vi.fn(async (id: string) => logs.get(id) ?? null), markDone },
}));
vi.mock("../broadcast.js", () => ({ broadcastService: { stopPinging, withdrawBroadcast } }));
vi.mock("../pinger.js", () => ({ remindBroadcast }));
const applyAnnouncementEdit = vi.fn();
class AnnouncementEditFailure extends Error { constructor(readonly code: string) { super(code); } }
vi.mock("../announcement-edit.js", () => ({ applyAnnouncementEdit, AnnouncementEditFailure }));
vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: syncSafe }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn().mockResolvedValue("OK"), eval: vi.fn().mockResolvedValue(1) } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../config.js", () => ({
    get ANNOUNCEMENTS_COMMANDS_ENABLED() { return flag.enabled; },
    PING_CONFIG: { TIME_ZONE: "Europe/Kyiv", QUIET_FROM_HOUR: 22, QUIET_UNTIL_HOUR: 10 },
}));
vi.mock("../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { AnnouncementCommandDispatcher } = await import("../announcement-commands.js");

const ACTION = "44444444-4444-4444-8444-444444444444";
const ANN = "55555555-5555-4555-8555-555555555555";
const api = { sendMessage: vi.fn() } as never;
const run = (command: unknown) => {
    listPending.mockResolvedValue({ items: [command] });
    return new AnnouncementCommandDispatcher().runOnce(api);
};
const live = { id: 7, publicId: ANN, withdrawnAt: null, remindersStoppedAt: null, manualRemindAt: null, manualRemindActionId: null };

beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    logs.clear();
    findByPublicId.mockResolvedValue({ ...live });
    remindBroadcast.mockResolvedValue({ sent: 2, failed: 0 });
    withdrawBroadcast.mockResolvedValue({ deleted: 5, failed: 1, deletedChats: 2, stayed: ["20"] });
});

describe("REMIND", () => {
    const remind = (notBefore: string | null = null) => ({ kind: "REMIND", publicId: ACTION, announcementPublicId: ANN, notBefore });

    it("by day reminds at once, closes the action and acks", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T11:00:00Z")); // 13:00 Киев
        await run(remind());
        expect(remindBroadcast).toHaveBeenCalledWith({ api }, 7, ACTION, expect.any(Date));
        expect(markDone).toHaveBeenCalledWith(ACTION, 7, "REMIND");
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("at 23:10 Kyiv stores manualRemindAt = 10:00 next morning and sends nothing", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T21:10:00Z")); // 23:10 Киев (UTC+2)
        await run(remind());
        expect(remindBroadcast).not.toHaveBeenCalled();
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: new Date("2026-10-28T08:00:00.000Z"), manualRemindActionId: ACTION });
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("a future notBefore wins over a daytime now", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T11:00:00Z"));
        await run(remind("2026-10-28T08:00:00.000Z"));
        expect(remindBroadcast).not.toHaveBeenCalled();
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { manualRemindAt: new Date("2026-10-28T08:00:00.000Z"), manualRemindActionId: ACTION });
    });

    it("a redelivered action already in the log only acks", async () => {
        logs.set(ACTION, { publicId: ACTION, result: null });
        await run(remind());
        expect(remindBroadcast).not.toHaveBeenCalled();
        expect(broadcastUpdate).not.toHaveBeenCalled();
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("a redelivered deferred action does not move manualRemindAt", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T21:30:00Z"));
        findByPublicId.mockResolvedValue({ ...live, manualRemindAt: new Date("2026-10-28T08:00:00Z"), manualRemindActionId: ACTION });
        await run(remind());
        expect(broadcastUpdate).not.toHaveBeenCalled();
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("failed chats make the command fail (retry) and do not close the action", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T11:00:00Z"));
        remindBroadcast.mockResolvedValue({ sent: 1, failed: 1 });
        await run(remind());
        expect(markDone).not.toHaveBeenCalled();
        expect(ackFailed).toHaveBeenCalledWith(ACTION, "REMIND_FAILED");
    });

    it("unknown announcement is failed with a code", async () => {
        findByPublicId.mockResolvedValue(null);
        await run(remind());
        expect(ackFailed).toHaveBeenCalledWith(ACTION, "BROADCAST_NOT_FOUND");
    });
});

describe("STOP", () => {
    const stop = { kind: "STOP", publicId: ACTION, announcementPublicId: ANN, actorName: "Olha" };

    it("stops pinging with the actor name, logs and acks", async () => {
        await run(stop);
        expect(stopPinging).toHaveBeenCalledWith(7, "Olha");
        expect(markDone).toHaveBeenCalledWith(ACTION, 7, "STOP");
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("keeps the first stopper when reminders are already stopped", async () => {
        findByPublicId.mockResolvedValue({ ...live, remindersStoppedAt: new Date() });
        await run(stop);
        expect(stopPinging).not.toHaveBeenCalled();
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });
});

describe("WITHDRAW", () => {
    const withdraw = { kind: "WITHDRAW", publicId: ACTION, announcementPublicId: ANN, actorName: "Olha" };

    it("withdraws as the named actor and acks with the honest per-chat result", async () => {
        await run(withdraw);
        expect(withdrawBroadcast).toHaveBeenCalledWith(api, 7, { name: "Olha" }, { sweep: true });
        expect(ackAccepted).toHaveBeenCalledWith(ACTION, { deletedChats: 2, stayed: ["20"] });
    });

    it("a redelivered action re-acks the stored result without deleting again", async () => {
        await run(withdraw);
        ackAccepted.mockClear();
        withdrawBroadcast.mockClear();
        await run(withdraw);
        expect(withdrawBroadcast).not.toHaveBeenCalled();
        expect(ackAccepted).toHaveBeenCalledWith(ACTION, { deletedChats: 2, stayed: ["20"] });
    });
});

describe("EDIT and future kinds", () => {
    const edit = { kind: "EDIT", publicId: ACTION, announcementPublicId: ANN, messageHtml: "x", reconfirm: false, textAsCaption: false, replacements: [], actorName: "O" };

    it("EDIT is applied to the broadcast and acked", async () => {
        applyAnnouncementEdit.mockResolvedValue({ edited: 1, failed: 0, reconfirmed: 0 });
        await run(edit);
        expect(applyAnnouncementEdit).toHaveBeenCalledWith(api, 7, expect.objectContaining({ kind: "EDIT", publicId: ACTION }));
        expect(ackAccepted).toHaveBeenCalledWith(ACTION);
    });

    it("EDIT that failed everywhere is failed-acked with the code", async () => {
        applyAnnouncementEdit.mockRejectedValue(new AnnouncementEditFailure("EDIT_FAILED"));
        await run(edit);
        expect(ackFailed).toHaveBeenCalledWith(ACTION, "EDIT_FAILED");
    });
});
