import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastFindUnique = vi.fn();
const userFindMany = vi.fn();
const locationFindMany = vi.fn();
const putSnapshot = vi.fn();
const getJob = vi.fn();
const queueAdd = vi.fn();
const flag = { enabled: true };

vi.mock("../../db/core.js", () => ({
    default: {
        broadcast: { findUnique: broadcastFindUnique },
        user: { findMany: userFindMany },
        location: { findMany: locationFindMany },
    },
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { getJob, add: queueAdd } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { putAnnouncementSnapshot: putSnapshot },
}));
vi.mock("../../config.js", () => ({
    TEAM_CHATS: { HUB: -1001 },
    get ANNOUNCEMENTS_SYNC_ENABLED() { return flag.enabled; },
}));

const {
    buildAnnouncementSnapshot,
    enqueueAnnouncementSync,
    enqueueAnnouncementSyncSafe,
    processAnnouncementSync,
} = await import("../announcement-sync.js");

const T = (m: number) => new Date(Date.UTC(2026, 9, 26, 10, m, 0));

function baseBroadcast(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        publicId: "11111111-1111-4111-8111-111111111111",
        initiatorId: 900n,
        messageText: "<b>Привіт</b>",
        createdAt: T(0),
        completedAt: null,
        cancelledAt: null,
        targetSummary: "👤 All Staff (PM)",
        withdrawnAt: null,
        withdrawnByTelegramId: null,
        buttonType: "default",
        attachmentKinds: ["photo"],
        remindersStoppedAt: null,
        remindersStoppedByName: null,
        withdrawnByName: null,
        textAsCaption: false,
        actionLogs: [],
        deliveries: [],
        pingLogs: [],
        trackedMessages: [],
        ...overrides,
    };
}

const user = (telegramId: bigint, extra: Record<string, unknown> = {}) => ({
    telegramId,
    firstName: null,
    lastName: null,
    username: null,
    staffProfile: null,
    supportThread: null,
    ...extra,
});

describe("buildAnnouncementSnapshot", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        flag.enabled = true;
        userFindMany.mockResolvedValue([]);
        locationFindMany.mockResolvedValue([]);
    });

    it("webapp-origin broadcast: source WEBAPP, author name from the broadcast, no fake telegram author", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({ initiatorId: 0n, origin: "WEBAPP", authorName: "Віталій" }));

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.source).toBe("WEBAPP");
        expect(snap.authorName).toBe("Віталій");
        expect(snap.authorTelegramId).toBeUndefined();
        expect(snap.activity[0]).toMatchObject({ kind: "SENT", actorName: "Віталій" });
    });

    it("carries textAsCaption, the stopper, the withdrawer name and the done actions", async () => {
        const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            textAsCaption: true,
            remindersStoppedAt: T(5),
            remindersStoppedByName: "Olha",
            withdrawnAt: T(9),
            withdrawnByName: "Ivan",
            actionLogs: [{ publicId: A1 }, { publicId: A2 }],
        }));

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.textAsCaption).toBe(true);
        expect(snap.remindersStoppedByName).toBe("Olha");
        expect(snap.withdrawnByName).toBe("Ivan");
        expect(snap.actionsDone).toEqual([A1, A2]);
        expect(snap.activity).toContainEqual(expect.objectContaining({ kind: "STOPPED", actorName: "Olha" }));
        expect(snap.activity).toContainEqual(expect.objectContaining({ kind: "WITHDRAWN", actorName: "Ivan" }));
    });

    it("personal broadcast with default buttons: statuses, decline reason, delivery error", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            deliveries: [
                { chatId: 1n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null },
                { chatId: 2n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null },
                { chatId: 3n, targetType: "USER", status: "FAILED", sentAt: null, lastError: "x".repeat(900) },
            ],
            trackedMessages: [
                { chatId: 1n, nextPingAt: null, pingUntil: null, pendingReplies: [{ userId: 1n, status: "confirmed", respondedAt: T(5), declineReason: null }] },
                { chatId: 2n, nextPingAt: null, pingUntil: null, pendingReplies: [{ userId: 2n, status: "declined", respondedAt: T(6), declineReason: "Не можу" }] },
            ],
        }));
        userFindMany.mockResolvedValue([
            user(900n, { firstName: "Адмін" }),
            user(1n, { staffProfile: { fullName: "Іра Коваль" } }),
            user(2n, { firstName: "Оля", lastName: "Мельник" }),
            user(3n, { username: "vasya" }),
        ]);

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.replyMode).toBe("CONFIRM");
        expect(snap.source).toBe("BOT");
        expect(snap.authorTelegramId).toBe("900");
        expect(snap.authorName).toBe("Адмін");
        expect(snap.recipients).toHaveLength(3);
        const [a, b, c] = snap.recipients;
        expect(a).toMatchObject({ telegramId: "1", displayName: "Іра Коваль", deliveryStatus: "SENT", replyStatus: "CONFIRMED" });
        expect(b).toMatchObject({ displayName: "Оля Мельник", replyStatus: "DECLINED", declineReason: "Не можу" });
        expect(c).toMatchObject({ displayName: "@vasya", deliveryStatus: "FAILED" });
        expect(c!.deliveryError).toHaveLength(500);
        expect(c!.replyStatus).toBeUndefined();
    });

    it("group broadcast: participants without deliveryStatus, one chat titled by location", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            deliveries: [{ chatId: -100555n, targetType: "GROUP", status: "SENT", sentAt: T(1), lastError: null }],
            trackedMessages: [{
                chatId: -100555n, nextPingAt: T(30), pingUntil: T(90),
                pendingReplies: [
                    { userId: 11n, status: "pending", respondedAt: null, declineReason: null },
                    { userId: 12n, status: "dropped", respondedAt: null, declineReason: null },
                ],
            }],
        }));
        locationFindMany.mockResolvedValue([{ name: "Smile Park", telegramChatId: -100555n }]);

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.recipients).toHaveLength(2);
        expect(snap.recipients.every(r => r.deliveryStatus === undefined)).toBe(true);
        expect(snap.recipients.map(r => r.replyStatus)).toEqual(["PENDING", "DROPPED"]);
        expect(snap.recipients[0]!.displayName).toBe("Telegram user");
        expect(snap.chats).toEqual([{ chatId: "-100555", title: "Smile Park", deliveryStatus: "SENT", deliveredAt: T(1).toISOString() }]);
        expect(snap.nextReminderAt).toBe(T(30).toISOString());
        expect(snap.reminderUntil).toBe(T(90).toISOString());
    });

    it("HUB chat gets the HUB title", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            deliveries: [{ chatId: -1001n, targetType: "GROUP", status: "PENDING", sentAt: null, lastError: null }],
        }));
        const snap = await buildAnnouncementSnapshot(7);
        expect(snap.chats[0]).toMatchObject({ chatId: "-1001", title: "HUB", deliveryStatus: "PENDING" });
    });

    it("support topic link comes from SupportThread", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            deliveries: [{ chatId: 1n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null }],
        }));
        userFindMany.mockResolvedValue([user(1n, { supportThread: { chatId: -1003794600501n, topicId: 52151 } })]);
        const snap = await buildAnnouncementSnapshot(7);
        expect(snap.recipients[0]!.supportTopicUrl).toBe("https://t.me/c/3794600501/52151");
    });

    it("support topic link is omitted for non-supergroup chats and bad topic ids", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            deliveries: [
                { chatId: 1n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null },
                { chatId: 2n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null },
                { chatId: 3n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null },
            ],
        }));
        userFindMany.mockResolvedValue([
            user(1n, { supportThread: { chatId: -5000n, topicId: 9 } }),
            user(2n, { supportThread: { chatId: 777n, topicId: 9 } }),
            user(3n, { supportThread: { chatId: -1003794600501n, topicId: 0 } }),
        ]);
        const snap = await buildAnnouncementSnapshot(7);
        for (const r of snap.recipients) expect(r).not.toHaveProperty("supportTopicUrl");
    });

    it("author without a User row falls back to 'Telegram user'; reply mode maps buttonType", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({ buttonType: "none" }));
        let snap = await buildAnnouncementSnapshot(7);
        expect(snap.authorName).toBe("Telegram user");
        expect(snap.replyMode).toBe("NONE");

        broadcastFindUnique.mockResolvedValue(baseBroadcast({ buttonType: "preferences" }));
        snap = await buildAnnouncementSnapshot(7);
        expect(snap.replyMode).toBe("PREFERENCES");
    });

    it("old broadcast with null buttonType takes the kind from its first tracked message", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            buttonType: null,
            trackedMessages: [
                { chatId: 1n, buttonType: "preferences", nextPingAt: null, pingUntil: null, pendingReplies: [] },
                { chatId: 2n, buttonType: "default", nextPingAt: null, pingUntil: null, pendingReplies: [] },
            ],
        }));
        expect((await buildAnnouncementSnapshot(7)).replyMode).toBe("PREFERENCES");

        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            buttonType: null,
            trackedMessages: [{ chatId: 1n, buttonType: "default", nextPingAt: null, pingUntil: null, pendingReplies: [] }],
        }));
        expect((await buildAnnouncementSnapshot(7)).replyMode).toBe("CONFIRM");

        broadcastFindUnique.mockResolvedValue(baseBroadcast({ buttonType: null, trackedMessages: [] }));
        expect((await buildAnnouncementSnapshot(7)).replyMode).toBe("NONE");
    });

    it("loads tracked messages in id order so the buttonType fallback is deterministic", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({ buttonType: null, trackedMessages: [] }));
        await buildAnnouncementSnapshot(7);
        expect(broadcastFindUnique.mock.calls.at(-1)![0].include.trackedMessages).toMatchObject({ orderBy: { id: "asc" } });
    });

    it("activity over the cap keeps the newest reminders and never drops STOPPED/WITHDRAWN", async () => {
        const pingLogs = Array.from({ length: 1200 }, (_, i) => ({
            chatId: 1n,
            sentAt: new Date(T(0).getTime() + (i + 1) * 120_000),
        }));
        const lastPing = pingLogs[1199]!.sentAt;
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            pingLogs,
            remindersStoppedAt: new Date(lastPing.getTime() + 60_000),
            withdrawnAt: new Date(lastPing.getTime() + 120_000),
        }));

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.activity).toHaveLength(1000);
        expect(snap.activity[0]!.kind).toBe("SENT");
        expect(snap.activity.at(-1)!.kind).toBe("WITHDRAWN");
        expect(snap.activity.at(-2)!.kind).toBe("STOPPED");
        expect(snap.activity.at(-3)!.at).toBe(lastPing.toISOString());
        expect(snap.activity.filter(a => a.kind === "REMINDED")).toHaveLength(997);
        const ats = snap.activity.map(a => a.at);
        expect([...ats].sort()).toEqual(ats);
    });

    it("activity: pings grouped by minute, stop and withdraw recorded; message truncated", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast({
            messageText: "m".repeat(25_000),
            completedAt: T(2),
            remindersStoppedAt: T(50),
            withdrawnAt: T(60),
            withdrawnByTelegramId: 900n,
            deliveries: [{ chatId: 1n, targetType: "USER", status: "SENT", sentAt: T(1), lastError: null }],
            pingLogs: [
                { chatId: 1n, sentAt: new Date(T(10).getTime() + 5_000) },
                { chatId: 2n, sentAt: new Date(T(10).getTime() + 20_000) },
                { chatId: 1n, sentAt: T(40) },
            ],
        }));
        userFindMany.mockResolvedValue([user(900n, { firstName: "Адмін" })]);

        const snap = await buildAnnouncementSnapshot(7);

        expect(snap.messageHtml).toHaveLength(20_000);
        expect(snap.activity.map(a => [a.kind, a.count])).toEqual([
            ["SENT", undefined], ["DELIVERED", 1], ["REMINDED", 2], ["REMINDED", 1], ["STOPPED", undefined], ["WITHDRAWN", undefined],
        ]);
        expect(snap.activity[0]!.actorName).toBe("Адмін");
        expect(snap.activity[5]!.actorName).toBe("Адмін");
        expect(snap.withdrawnByName).toBe("Адмін");
    });
});

describe("enqueueAnnouncementSync", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        flag.enabled = true;
    });

    it("is a no-op when the flag is off", async () => {
        flag.enabled = false;
        await enqueueAnnouncementSync(7);
        expect(getJob).not.toHaveBeenCalled();
        expect(queueAdd).not.toHaveBeenCalled();
    });

    it("adds one debounced job and skips when it is still waiting", async () => {
        getJob.mockResolvedValueOnce(undefined);
        await enqueueAnnouncementSync(7);
        expect(queueAdd).toHaveBeenCalledWith(
            "announcement-sync",
            { broadcastId: 7 },
            { jobId: "announcement-sync-7", delay: 3_000, attempts: 8, backoff: { type: "exponential", delay: 10_000 } },
        );

        getJob.mockResolvedValueOnce({ getState: async () => "delayed", remove: vi.fn() });
        await enqueueAnnouncementSync(7);
        expect(queueAdd).toHaveBeenCalledTimes(1);
    });

    it("removes a completed job so later changes sync again", async () => {
        const remove = vi.fn();
        getJob.mockResolvedValueOnce({ getState: async () => "completed", remove });
        await enqueueAnnouncementSync(7);
        expect(remove).toHaveBeenCalled();
        expect(queueAdd).toHaveBeenCalledTimes(1);
    });

    it("an active job gets a follow-up job", async () => {
        getJob.mockResolvedValueOnce({ getState: async () => "active", remove: vi.fn() });
        getJob.mockResolvedValueOnce(undefined);
        await enqueueAnnouncementSync(7);
        expect(queueAdd).toHaveBeenCalledWith("announcement-sync", { broadcastId: 7 }, expect.objectContaining({ jobId: "announcement-sync-7-next" }));
    });

    it("safe wrapper swallows queue failures", async () => {
        getJob.mockRejectedValueOnce(new Error("redis down"));
        await expect(enqueueAnnouncementSyncSafe(7)).resolves.toBeUndefined();
    });
});

describe("processAnnouncementSync", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        flag.enabled = true;
        userFindMany.mockResolvedValue([]);
        locationFindMany.mockResolvedValue([]);
    });

    it("sends a fresh snapshot to the broadcast's publicId", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast());
        putSnapshot.mockResolvedValue(undefined);
        await processAnnouncementSync(7);
        expect(putSnapshot).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", expect.objectContaining({ botBroadcastId: 7 }));
    });

    it("rethrows a client failure so BullMQ retries", async () => {
        broadcastFindUnique.mockResolvedValue(baseBroadcast());
        putSnapshot.mockRejectedValue(new Error("503"));
        await expect(processAnnouncementSync(7)).rejects.toThrow("503");
    });
});
