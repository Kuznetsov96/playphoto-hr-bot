import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastCreate = vi.fn();
const broadcastUpdate = vi.fn();
const broadcastDelete = vi.fn();
const deliveryCreateMany = vi.fn();
const deliveryFindUnique = vi.fn();
const trackedCreate = vi.fn();
const pendingReplyCreate = vi.fn();
const userUpsert = vi.fn();
const queueAdd = vi.fn();
const resolveRecipients = vi.fn();
const staffFindActive = vi.fn();

vi.mock("../../repositories/staff-repository.js", () => ({ staffRepository: { findActive: staffFindActive } }));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: vi.fn().mockResolvedValue([]), findById: vi.fn() },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { create: broadcastCreate, update: broadcastUpdate, delete: broadcastDelete, getMediaFileIds: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: {
        createMany: deliveryCreateMany,
        findUnique: deliveryFindUnique,
        claimPending: vi.fn().mockResolvedValue({ count: 1 }),
        markSent: vi.fn(),
        markSkipped: vi.fn(),
        markFailed: vi.fn(),
        getStats: vi.fn().mockResolvedValue({ SENT: 2 }),
    },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({ trackedMessageRepository: { create: trackedCreate } }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: { create: pendingReplyCreate } }));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: { upsert: userUpsert } }));
vi.mock("../../core/queue.js", () => ({ broadcastQueue: { add: queueAdd } }));
vi.mock("../../core/redis.js", () => ({ redis: { get: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { missingSchedulePreferences: vi.fn(), resolveAnnouncementRecipients: resolveRecipients, openAnnouncementAttachment: vi.fn() } }));
vi.mock("../../config.js", () => ({ TEAM_CHATS: { HUB: -1001 }, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: false }));
vi.mock("../../handlers/admin/utils.js", () => ({ normalizeCity: (value: string) => value }));


import { readFileSync } from "node:fs";

const layoutCases = JSON.parse(
    readFileSync(new URL("./__fixtures__/announcement-layout-cases.json", import.meta.url), "utf8"),
) as Array<{ name: string; input: any; expected: unknown }>;

const TARGET = { everyone: false, cityNames: ["Kyiv"], locationPublicIds: [] };
const photo = (id: string) => ({ kind: "photo" as const, fileId: id });
const doc = (id: string) => ({ kind: "document" as const, fileId: id, fileName: "a.pdf" });

describe("announcement created in the bot is sent like a webapp one", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        staffFindActive.mockResolvedValue([]);
        broadcastCreate.mockResolvedValue({ id: 42 });
        deliveryCreateMany.mockResolvedValue({ count: 2 });
        deliveryFindUnique.mockResolvedValue({ id: 7, status: "PENDING" });
        trackedCreate.mockResolvedValue({ id: 900 });
        userUpsert.mockResolvedValue({});
        queueAdd.mockResolvedValue({});
        resolveRecipients.mockResolvedValue({ count: 2, telegramIds: ["100", "200"] });
    });

    const run = async (input: Partial<import("../broadcast.js").BotAnnouncementInput>, api: any) => {
        const { broadcastService } = await import("../broadcast.js");
        const created = await broadcastService.createBotAnnouncement(null, { telegramId: 555n, name: "Admin A" }, {
            target: TARGET, replyMode: "CONFIRM", reminders: true, textHtml: "<b>Hi</b>", media: [], ...input,
        });
        const job = queueAdd.mock.calls.at(-1)![1];
        await broadcastService.processBroadcast(job, api);
        return { created, job };
    };

    it("one photo and a short text: one message with a caption and the buttons", async () => {
        const api = { sendPhoto: vi.fn().mockResolvedValue({ message_id: 9, photo: [{ file_id: "p" }] }), sendMessage: vi.fn(), sendMediaGroup: vi.fn() };
        await run({ media: [photo("F1")] }, api);

        expect(api.sendPhoto).toHaveBeenCalledTimes(2);
        const [, file, options] = api.sendPhoto.mock.calls[0]!;
        expect(file).toBe("F1");
        expect(options.caption).toBe("<b>Hi</b>");
        expect(options.parse_mode).toBe("HTML");
        expect(options.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data))
            .toEqual(["broadcast_confirm_ok_42", "broadcast_confirm_decline_42"]);
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({ origin: "BOT", authorName: "Admin A", textAsCaption: true }));
    });

    it("3 photos and a file with a text: album, file, then the text with the buttons", async () => {
        const api = {
            sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 1 }, { message_id: 2 }, { message_id: 3 }]),
            sendDocument: vi.fn().mockResolvedValue({ message_id: 4 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 5 }),
            sendPhoto: vi.fn(),
        };
        await run({ media: [photo("A"), photo("B"), photo("C"), doc("D")] }, api);

        expect(api.sendMediaGroup.mock.calls[0]![1].map((m: { media: string }) => m.media)).toEqual(["A", "B", "C"]);
        expect(api.sendDocument.mock.calls[0]![1]).toBe("D");
        const [, text, extra] = api.sendMessage.mock.calls[0]!;
        expect(text).toBe("<b>Hi</b>");
        expect(extra.reply_markup).toBeDefined();
        expect(api.sendDocument.mock.calls[0]![2].reply_markup).toBeUndefined();
        expect(broadcastCreate).toHaveBeenCalledWith(expect.not.objectContaining({ textAsCaption: true }));
        expect(trackedCreate.mock.calls[0]![0].messageId).toBe(5);
    });

    it("a long text with one photo stays out of the caption", async () => {
        const api = { sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }), sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }) };
        await run({ media: [photo("A")], textHtml: "x".repeat(1025) }, api);
        expect(api.sendPhoto.mock.calls[0]![2].caption).toBeUndefined();
        expect(api.sendMessage).toHaveBeenCalled();
    });

    it("NONE: no buttons, no reminders", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }) };
        await run({ replyMode: "NONE", reminders: true }, api);

        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({ buttonType: "none", remindersEnabled: false }));
        expect(api.sendMessage.mock.calls[0]![2].reply_markup).toBeUndefined();
        expect(trackedCreate).not.toHaveBeenCalled();
    });

    it("reminders on: first after 20 h, every 4 h, until +4 days", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }) };
        const before = Date.now();
        await run({}, api);

        const tracked = trackedCreate.mock.calls[0]![0];
        expect(tracked.pingIntervalMs).toBe(4 * 3_600_000);
        expect(new Date(tracked.pingUntil).getTime()).toBeGreaterThanOrEqual(before + 4 * 86_400_000);
        expect(tracked.nextPingAt.getTime()).toBeGreaterThanOrEqual(before + 20 * 3_600_000);
        expect(tracked.nextPingAt.getTime()).toBeLessThan(before + 20 * 3_600_000 + 5_000);
        expect(broadcastCreate).toHaveBeenCalledWith(expect.not.objectContaining({ remindersEnabled: false }));
    });

    it("reminders off: remindersEnabled=false and no nextPingAt", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }) };
        await run({ reminders: false }, api);
        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({ remindersEnabled: false }));
        expect(trackedCreate.mock.calls[0]![0].nextPingAt).toBeNull();
    });

    it("the count is what the webapp resolved at send time, each person once", async () => {
        resolveRecipients.mockResolvedValue({ count: 3, telegramIds: ["1", "2", "3", "3"] });
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }) };
        const { created } = await run({}, api);
        expect(resolveRecipients).toHaveBeenCalledWith(TARGET);
        expect(created).toEqual({ broadcastId: 42, count: 3 });
        expect(broadcastCreate).toHaveBeenCalledWith(expect.objectContaining({ targetSummary: "👤 Recipients (3)" }));
    });

    it("refuses an empty audience instead of creating a broadcast", async () => {
        resolveRecipients.mockResolvedValue({ count: 0, telegramIds: [] });
        const { broadcastService } = await import("../broadcast.js");
        await expect(broadcastService.createBotAnnouncement(null, { telegramId: 1, name: "A" }, {
            target: TARGET, replyMode: "NONE", reminders: false, textHtml: "x", media: [],
        })).rejects.toThrow("NO_RECIPIENTS");
        expect(broadcastCreate).not.toHaveBeenCalled();
    });

    it("the monthly schedule broadcast keeps its old path (pm_all, preferences keyboard, no parts sender)", async () => {
        staffFindActive.mockResolvedValue([{ user: { telegramId: 100n }, locationId: "l", location: { city: "Kyiv" } }]);
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 3 }), sendPhoto: vi.fn() };
        const { broadcastService } = await import("../broadcast.js");
        await broadcastService.createBroadcast(api, 1, "Заповни", { type: "pm_all" }, undefined, undefined, { buttonType: "preferences" });
        const job = queueAdd.mock.calls.at(-1)![1];
        expect(job.partsSender).toBeUndefined();
        await broadcastService.processBroadcast(job, api);
        expect(api.sendMessage.mock.calls[0]![2].reply_markup.inline_keyboard.flat()[0].callback_data).toBe("pref_fill");
        expect(api.sendMessage.mock.calls[0]![2].link_preview_options).toBeUndefined();
    });
});

describe("announcement layout matches the webapp fixture", () => {
    it.each(layoutCases)("$name", async ({ input, expected }) => {
        const { announcementLayout } = await import("../announcement-layout.js");
        expect(announcementLayout(input)).toEqual(expected);
    });

    it("counts visible UTF-16 units, not markup", async () => {
        const { visibleLength } = await import("../announcement-layout.js");
        expect(visibleLength('<b>a</b><a href="https://x.y/very/long">b&amp;c</a>')).toBe(4);
        expect(visibleLength("\n<i>😀</i>\n")).toBe(2);
    });
});
