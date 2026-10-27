import { beforeEach, describe, expect, it, vi } from "vitest";

const listPending = vi.fn();
const ackAccepted = vi.fn();
const ackFailed = vi.fn();
const findByPublicId = vi.fn();
const createBroadcast = vi.fn();
const sendTestBroadcast = vi.fn();
const enqueueBroadcastJob = vi.fn();
const openAttachment = vi.fn();
const redisSet = vi.fn();
const redisEval = vi.fn();
const flag = { enabled: true };

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingAnnouncementCommands: listPending,
        ackAnnouncementCommandAccepted: ackAccepted,
        ackAnnouncementCommandFailed: ackFailed,
        openAnnouncementAttachment: openAttachment,
    },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { findByPublicId },
}));
vi.mock("../broadcast.js", () => ({
    broadcastService: { createBroadcast, sendTestBroadcast, enqueueBroadcastJob },
}));
vi.mock("../../core/redis.js", () => ({ redis: { set: redisSet, eval: redisEval } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../config.js", () => ({
    get ANNOUNCEMENTS_COMMANDS_ENABLED() { return flag.enabled; },
}));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { AnnouncementCommandDispatcher, ANNOUNCEMENT_COMMAND_POLL_MS } = await import("../announcement-commands.js");

const ID = "11111111-1111-4111-8111-111111111111";
const api = { sendMessage: vi.fn() } as never;

const send = (overrides: Record<string, unknown> = {}) => ({
    kind: "SEND" as const,
    publicId: ID,
    messageHtml: "<b>Привіт</b>",
    replyMode: "CONFIRM" as const,
    recipients: ["100", "200", "100"],
    reminders: { firstAfterMs: 3_600_000, everyMs: 7_200_000, untilIso: "2026-11-01T10:00:00.000Z" },
    authorName: "Віталій",
    attachments: [],
    textAsCaption: false,
    ...overrides,
});
const test = (overrides: Record<string, unknown> = {}) => ({
    kind: "TEST" as const,
    publicId: ID,
    telegramId: "555",
    messageHtml: "<i>тест</i>",
    replyMode: "CONFIRM" as const,
    attachments: [],
    textAsCaption: false,
    ...overrides,
});

describe("AnnouncementCommandDispatcher", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        redisSet.mockResolvedValue("OK");
        redisEval.mockResolvedValue(1);
        findByPublicId.mockResolvedValue(null);
        createBroadcast.mockResolvedValue(2);
        enqueueBroadcastJob.mockResolvedValue(undefined);
        sendTestBroadcast.mockResolvedValue({ message_id: 1 });
        ackAccepted.mockResolvedValue(undefined);
        ackFailed.mockResolvedValue(undefined);
    });

    it("polls every 15 seconds", () => {
        expect(ANNOUNCEMENT_COMMAND_POLL_MS).toBe(15_000);
    });

    it("SEND: creates the broadcast with the webapp publicId for an explicit id list, then accepts", async () => {
        listPending.mockResolvedValue({ items: [send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(listPending).toHaveBeenCalledWith(20);
        expect(createBroadcast).toHaveBeenCalledWith(
            null,
            0,
            "<b>Привіт</b>",
            { type: "pm_ids", value: ["100", "200"] },
            undefined,
            undefined,
            {
                buttonType: "default",
                initialDelayMs: 3_600_000,
                repeatIntervalMs: 7_200_000,
                pingUntil: new Date("2026-11-01T10:00:00.000Z"),
            },
            { publicId: ID, origin: "WEBAPP", authorName: "Віталій" },
        );
        expect(ackAccepted).toHaveBeenCalledWith(ID);
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("SEND is idempotent: an existing Broadcast is not recreated; its job is re-enqueued (same jobId dedupes) and then accepted", async () => {
        findByPublicId.mockResolvedValue({ id: 5, messageText: "<b>Привіт</b>" });
        listPending.mockResolvedValue({ items: [send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(createBroadcast).not.toHaveBeenCalled();
        expect(enqueueBroadcastJob).toHaveBeenCalledTimes(1);
        expect(enqueueBroadcastJob).toHaveBeenCalledWith(expect.objectContaining({
            broadcastId: 5,
            messageText: "<b>Привіт</b>",
            target: { type: "pm_ids", value: ["100", "200"] },
            pingOptions: expect.objectContaining({ buttonType: "default", initialDelayMs: 3_600_000, repeatIntervalMs: 7_200_000 }),
        }));
        expect(ackAccepted).toHaveBeenCalledWith(ID);
        // order: enqueue before ack
        expect(enqueueBroadcastJob.mock.invocationCallOrder[0]).toBeLessThan(ackAccepted.mock.invocationCallOrder[0]!);
    });

    it("SEND with an existing Broadcast whose job is already queued adds no second job (enqueue is the deduping jobId add)", async () => {
        findByPublicId.mockResolvedValue({ id: 5, messageText: "x" });
        listPending.mockResolvedValue({ items: [send(), send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        // Both calls use the same deterministic id inside enqueueBroadcastJob; the dispatcher never sends directly.
        expect(enqueueBroadcastJob.mock.calls.every(c => c[0].broadcastId === 5)).toBe(true);
        expect(createBroadcast).not.toHaveBeenCalled();
    });

    it("SEND: a failed re-enqueue of an existing Broadcast is acked failed (retry later)", async () => {
        findByPublicId.mockResolvedValue({ id: 5, messageText: "x" });
        enqueueBroadcastJob.mockRejectedValue(new Error("Redis down"));
        listPending.mockResolvedValue({ items: [send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackFailed).toHaveBeenCalledWith(ID, "SEND_FAILED");
    });

    it("SEND: a unique-index race (P2002) counts as already existing", async () => {
        createBroadcast.mockRejectedValue(Object.assign(new Error("Unique"), { code: "P2002" }));
        listPending.mockResolvedValue({ items: [send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackAccepted).toHaveBeenCalledWith(ID);
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("SEND with NONE reply mode uses the no-button broadcast and no reminders", async () => {
        listPending.mockResolvedValue({ items: [send({ replyMode: "NONE", reminders: null })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(createBroadcast.mock.calls[0]![6]).toEqual({ buttonType: "none", noReminders: true });
    });

    it("SEND without reminders on CONFIRM suppresses pings", async () => {
        listPending.mockResolvedValue({ items: [send({ reminders: null, authorName: null })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(createBroadcast.mock.calls[0]![6]).toEqual({ buttonType: "default", noReminders: true });
        expect(createBroadcast.mock.calls[0]![7]).toEqual({ publicId: ID, origin: "WEBAPP" });
    });

    it("SEND failure before creation is acked failed with a short code", async () => {
        createBroadcast.mockRejectedValue(new Error("Redis down"));
        listPending.mockResolvedValue({ items: [send()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackFailed).toHaveBeenCalledWith(ID, "SEND_FAILED");
        expect(ackAccepted).not.toHaveBeenCalled();
    });

    it("SEND without any valid recipient fails NO_RECIPIENTS", async () => {
        listPending.mockResolvedValue({ items: [send({ recipients: [] })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(createBroadcast).not.toHaveBeenCalled();
        expect(ackFailed).toHaveBeenCalledWith(ID, "NO_RECIPIENTS");
    });

    it("TEST sends one message without creating a Broadcast", async () => {
        listPending.mockResolvedValue({ items: [test(), test({ publicId: "22222222-2222-4222-8222-222222222222", replyMode: "NONE" })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(sendTestBroadcast).toHaveBeenNthCalledWith(1, api, 555, "<i>тест</i>", undefined, "default", false);
        expect(sendTestBroadcast).toHaveBeenNthCalledWith(2, api, 555, "<i>тест</i>", undefined, "none", false);
        expect(createBroadcast).not.toHaveBeenCalled();
        expect(findByPublicId).not.toHaveBeenCalled();
        expect(ackAccepted).toHaveBeenCalledTimes(2);
    });

    it.each([
        [{ error_code: 403, description: "Forbidden: bot was blocked by the user" }, "BOT_BLOCKED"],
        [{ error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }, "HTML_REJECTED"],
        [new Error("network"), "TEST_FAILED"],
    ])("TEST error %# maps to %s", async (error, code) => {
        sendTestBroadcast.mockRejectedValue(error);
        listPending.mockResolvedValue({ items: [test()] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackFailed).toHaveBeenCalledWith(ID, code);
        expect(ackAccepted).not.toHaveBeenCalled();
    });

    it("an unknown kind is failed per item and does not stop the rest", async () => {
        listPending.mockResolvedValue({
            items: [{ kind: "UNKNOWN", publicId: "33333333-3333-4333-8333-333333333333", receivedKind: "REVOKE" }, test()],
        });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackFailed).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", "UNKNOWN_KIND: REVOKE");
        expect(ackAccepted).toHaveBeenCalledWith(ID);
    });

    it("a lost ack does not throw", async () => {
        ackAccepted.mockRejectedValue(new Error("503"));
        listPending.mockResolvedValue({ items: [test()] });

        await expect(new AnnouncementCommandDispatcher().runOnce(api)).resolves.toBeUndefined();
    });

    it("does nothing while another instance holds the lease", async () => {
        redisSet.mockResolvedValue(null);

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(listPending).not.toHaveBeenCalled();
    });

    it("takes the lease with NX and releases it afterwards, even if the fetch fails", async () => {
        listPending.mockRejectedValue(new Error("down"));

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(redisSet).toHaveBeenCalledWith(
            "worker:announcement-command-dispatcher:lease", expect.any(String), "PX", 300_000, "NX",
        );
        expect(redisEval).toHaveBeenCalledTimes(1);
    });

    it("skips an overlapping tick in the same process", async () => {
        let release!: () => void;
        listPending.mockReturnValue(new Promise(resolve => { release = () => resolve({ items: [] }); }));
        const dispatcher = new AnnouncementCommandDispatcher();

        const first = dispatcher.runOnce(api);
        await Promise.resolve();
        await dispatcher.runOnce(api);
        release();
        await first;

        expect(listPending).toHaveBeenCalledTimes(1);
    });
});

describe("startAnnouncementCommandPoller", () => {
    it("does not start a timer while the flag is off, and ticks every 15 s when on", async () => {
        const { startAnnouncementCommandPoller } = await import("../announcement-commands.js");
        vi.clearAllMocks();
        redisSet.mockResolvedValue("OK");
        redisEval.mockResolvedValue(1);
        vi.useFakeTimers();
        listPending.mockResolvedValue({ items: [] });
        try {
            flag.enabled = false;
            expect(startAnnouncementCommandPoller(api)).toBeUndefined();

            flag.enabled = true;
            const timer = startAnnouncementCommandPoller(api);
            expect(timer).toBeDefined();
            await vi.advanceTimersByTimeAsync(15_000);
            expect(listPending).toHaveBeenCalledTimes(1);
            clearInterval(timer);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("AnnouncementCommandDispatcher: attachments", () => {
    const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const photo = { publicId: A1, kind: "photo" as const, fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, width: 800, height: 600, durationSec: null };
    const doc = { publicId: A2, kind: "document" as const, fileName: "b.pdf", mimeType: "application/pdf", sizeBytes: 20, width: null, height: null, durationSec: null };
    const cancel = vi.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        vi.clearAllMocks();
        redisSet.mockResolvedValue("OK");
        redisEval.mockResolvedValue(1);
        findByPublicId.mockResolvedValue(null);
        createBroadcast.mockResolvedValue(2);
        sendTestBroadcast.mockResolvedValue({ message_id: 1 });
        ackAccepted.mockResolvedValue(undefined);
        ackFailed.mockResolvedValue(undefined);
        openAttachment.mockResolvedValue({ stream: { cancel }, contentType: "image/jpeg", sizeBytes: 10 });
    });

    it("SEND: checks every attachment, then creates the broadcast with media items and textAsCaption", async () => {
        listPending.mockResolvedValue({ items: [send({ attachments: [photo, doc], textAsCaption: false })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(openAttachment).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledTimes(2);
        const args = createBroadcast.mock.calls[0] as unknown[];
        expect(args[4]).toEqual([
            { type: "photo", fileId: "", attachmentPublicId: A1, fileName: "a.jpg", mimeType: "image/jpeg", width: 800, height: 600, durationSec: null },
            { type: "document", fileId: "", attachmentPublicId: A2, fileName: "b.pdf", mimeType: "application/pdf", width: null, height: null, durationSec: null },
        ]);
        expect(args[7]).toEqual({ publicId: ID, origin: "WEBAPP", authorName: "Віталій" });
        expect(ackAccepted).toHaveBeenCalledWith(ID);
    });

    it("SEND: textAsCaption goes into the broadcast", async () => {
        listPending.mockResolvedValue({ items: [send({ attachments: [photo], textAsCaption: true })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect((createBroadcast.mock.calls[0] as unknown[])[7]).toMatchObject({ textAsCaption: true });
    });

    it("SEND: an unavailable attachment fails the command and creates nothing", async () => {
        openAttachment.mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));
        listPending.mockResolvedValue({ items: [send({ attachments: [photo, doc] })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(createBroadcast).not.toHaveBeenCalled();
        expect(enqueueBroadcastJob).not.toHaveBeenCalled();
        expect(ackFailed).toHaveBeenCalledWith(ID, "ATTACHMENT_UNAVAILABLE");
        expect(ackAccepted).not.toHaveBeenCalled();
    });

    it("TEST: passes attachments and textAsCaption to the test send", async () => {
        listPending.mockResolvedValue({ items: [test({ attachments: [photo], textAsCaption: true })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        const args = sendTestBroadcast.mock.calls[0] as unknown[];
        expect(args[3]).toEqual([expect.objectContaining({ type: "photo", attachmentPublicId: A1, fileId: "" })]);
        expect(args[4]).toBe("default");
        expect(args[5]).toBe(true);
        expect(ackAccepted).toHaveBeenCalledWith(ID);
    });

    it("TEST: a vanished attachment maps to ATTACHMENT_UNAVAILABLE", async () => {
        sendTestBroadcast.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
        listPending.mockResolvedValue({ items: [test({ attachments: [photo] })] });

        await new AnnouncementCommandDispatcher().runOnce(api);

        expect(ackFailed).toHaveBeenCalledWith(ID, "ATTACHMENT_UNAVAILABLE");
    });
});
