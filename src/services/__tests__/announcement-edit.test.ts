import { beforeEach, describe, expect, it, vi } from "vitest";

const findById = vi.fn();
const broadcastUpdate = vi.fn();
const getMediaFileIds = vi.fn();
const findLog = vi.fn();
const markDone = vi.fn();
const claimMark = vi.fn();
const releaseMark = vi.fn();
const findSentForEdit = vi.fn();
const appendPart = vi.fn();
const replyUpdate = vi.fn();
const replyUpdateMany = vi.fn();
const trackedUpdate = vi.fn();
const syncSafe = vi.fn();
const openAttachment = vi.fn();

vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { findById, update: broadcastUpdate, getMediaFileIds },
}));
vi.mock("../../repositories/broadcast-action-repository.js", () => ({
    broadcastActionRepository: { findLog, markDone, claimReminderMark: claimMark, releaseReminderMark: releaseMark },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: { findSentForEdit, appendPartMessageId: appendPart },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { update: replyUpdate, updateMany: replyUpdateMany },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({ trackedMessageRepository: { update: trackedUpdate } }));
vi.mock("../announcement-sync.js", () => ({ enqueueAnnouncementSyncSafe: syncSafe }));
vi.mock("../aws-business-client.js", () => ({ awsBusinessClient: { openAnnouncementAttachment: openAttachment } }));
const buildKeyboardCalls: unknown[][] = [];
const loggerWarn = vi.fn();
vi.mock("../broadcast.js", () => ({
    buildBroadcastKeyboard: (type: string, id: number, username?: string, isGroup?: boolean) => {
        buildKeyboardCalls.push([type, id, username, isGroup]);
        return { kb: type, id };
    },
    getBroadcastFollowUpText: () => "SERVICE LINE",
}));
vi.mock("../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn() } }));
vi.mock("../../config.js", () => ({
    PING_CONFIG: { TIME_ZONE: "Europe/Kyiv", QUIET_FROM_HOUR: 22, QUIET_UNTIL_HOUR: 10, REPEAT_DELAY_MS: 6 * 3600_000 },
}));

const { applyAnnouncementEdit, RECONFIRM_PROMPT, AnnouncementEditFailure } = await import("../announcement-edit.js");

const ACTION = "44444444-4444-4444-8444-444444444444";
const NEW_PHOTO = "66666666-6666-4666-8666-666666666666";
const attachment = (kind: "photo" | "video" | "document" = "photo") => ({
    publicId: NEW_PHOTO, kind, fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10, width: null, height: null, durationSec: null,
});
const command = (extra: Record<string, unknown> = {}) => ({
    kind: "EDIT" as const, publicId: ACTION, announcementPublicId: "x", messageHtml: "<b>New</b>",
    reconfirm: false, textAsCaption: false, replacements: [], actorName: "Olha", ...extra,
}) as never;

const api = {
    editMessageText: vi.fn(),
    editMessageCaption: vi.fn(),
    editMessageMedia: vi.fn(),
    sendMessage: vi.fn(),
    getMe: vi.fn(),
};

const delivery = (chatId: number, messageId: number | null, parts: number[], id = chatId) => ({
    id, chatId: BigInt(chatId), targetType: "USER", messageId, partMessageIds: parts, status: "SENT",
});
const tracked = (chatId: number, messageId: number, statuses: string[], extra: Record<string, unknown> = {}) => ({
    id: chatId, chatId: BigInt(chatId), messageId, buttonType: "default", nextPingAt: null, pingIntervalMs: 3600_000, pingUntil: null,
    pendingReplies: statuses.map((status, i) => ({ id: chatId * 10 + i, status, respondedAt: status === "pending" ? null : new Date("2026-10-26T10:00:00Z") })),
    ...extra,
});
const broadcastRow = (extra: Record<string, unknown> = {}) => ({
    id: 7, withdrawnAt: null, remindersStoppedAt: null, buttonType: "default", textAsCaption: false,
    attachmentKinds: [], remindersEnabled: true, trackedMessages: [tracked(10, 100, ["pending"])], ...extra,
});

beforeEach(() => {
    vi.clearAllMocks();
    buildKeyboardCalls.length = 0;
    findLog.mockResolvedValue(null);
    getMediaFileIds.mockResolvedValue({});
    claimMark.mockResolvedValue(true);
    broadcastUpdate.mockResolvedValue({});
    releaseMark.mockResolvedValue(undefined);
    replyUpdate.mockResolvedValue({});
    trackedUpdate.mockReset();
    trackedUpdate.mockResolvedValue({});
    findById.mockResolvedValue(broadcastRow());
    findSentForEdit.mockResolvedValue([]);
    api.editMessageText.mockResolvedValue(true);
    api.editMessageCaption.mockResolvedValue(true);
    api.editMessageMedia.mockResolvedValue(true);
    api.sendMessage.mockResolvedValue({ message_id: 900 });
});

describe("applyAnnouncementEdit text", () => {
    it("edits the caption of a caption broadcast with the keyboard", async () => {
        findById.mockResolvedValue(broadcastRow({ textAsCaption: true, attachmentKinds: ["photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ textAsCaption: true }));
        expect(api.editMessageCaption).toHaveBeenCalledWith(10, 100, {
            caption: "<b>New</b>", parse_mode: "HTML", reply_markup: { kb: "default", id: 7 },
        });
        expect(api.editMessageText).not.toHaveBeenCalled();
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { messageText: "<b>New</b>" });
        expect(markDone).toHaveBeenCalledWith(ACTION, 7, "EDIT", { edited: 1, failed: 0 });
    });

    it("edits text with the keyboard and no link preview", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command());
        expect(api.editMessageText).toHaveBeenCalledWith(10, 100, "<b>New</b>", {
            parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { kb: "default", id: 7 },
        });
    });

    it("sends no reply_markup for a broadcast without buttons", async () => {
        findById.mockResolvedValue(broadcastRow({ buttonType: "none" }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command());
        expect(api.editMessageText.mock.calls[0]![3]).not.toHaveProperty("reply_markup");
    });

    it("empty text under CONFIRM becomes the service line", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ messageHtml: "<b> </b>" }));
        expect(api.editMessageText.mock.calls[0]![2]).toBe("SERVICE LINE");
    });

    it("treats 'message is not modified' as success", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        api.editMessageText.mockRejectedValue({ description: "Bad Request: message is not modified: specified new message content..." });
        const outcome = await applyAnnouncementEdit(api, 7, command());
        expect(outcome.edited).toBe(1);
        expect(markDone).toHaveBeenCalled();
    });

    it("edits an old bot broadcast (media separate) through editMessageText on the button message", async () => {
        findById.mockResolvedValue(broadcastRow({ attachmentKinds: ["photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 55, [])]);
        await applyAnnouncementEdit(api, 7, command());
        expect(api.editMessageText).toHaveBeenCalledWith(10, 55, "<b>New</b>", expect.objectContaining({ parse_mode: "HTML" }));
        expect(api.editMessageMedia).not.toHaveBeenCalled();
    });

    it("a redelivered action returns the stored per-chat result", async () => {
        findLog.mockResolvedValue({ publicId: ACTION, result: { edited: 4, failed: 2 } });
        const outcome = await applyAnnouncementEdit(api, 7, command());
        expect(outcome).toMatchObject({ edited: 4, failed: 2 });
    });

    it("fails the chat instead of skipping when a separate text message would be cleared", async () => {
        findById.mockResolvedValue(broadcastRow({ buttonType: "none", messageText: "Old text", attachmentKinds: ["photo", "photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [101, 102])]);
        await expect(applyAnnouncementEdit(api, 7, command({ messageHtml: "<b> </b>" }))).rejects.toBeInstanceOf(AnnouncementEditFailure);
        expect(api.editMessageText).not.toHaveBeenCalled();
    });

    it("an attachment-only broadcast with no text keeps editing without error", async () => {
        findById.mockResolvedValue(broadcastRow({ buttonType: "none", messageText: "", attachmentKinds: ["photo", "photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [101, 102])]);
        const outcome = await applyAnnouncementEdit(api, 7, command({ messageHtml: "" }));
        expect(outcome).toMatchObject({ edited: 1, failed: 0 });
    });

    it("a redelivered action in the log does nothing", async () => {
        findLog.mockResolvedValue({ publicId: ACTION });
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(api.editMessageText).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe("applyAnnouncementEdit replacements", () => {
    it("replaces an album photo by partMessageIds[position]", async () => {
        findById.mockResolvedValue(broadcastRow({ attachmentKinds: ["photo", "photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 103, [101, 102, 103])]);
        api.editMessageMedia.mockResolvedValue({ message_id: 102, photo: [{ file_id: "s" }, { file_id: "NEWFILE" }] });
        openAttachment.mockResolvedValue({ stream: { cancel: vi.fn().mockResolvedValue(undefined) } });
        await applyAnnouncementEdit(api, 7, command({ replacements: [{ position: 1, attachment: attachment("video") }] }));
        expect(api.editMessageMedia).toHaveBeenCalledTimes(1);
        const call = api.editMessageMedia.mock.calls[0]!;
        expect(call.slice(0, 2)).toEqual([10, 102]);
        expect(call[2]).toMatchObject({ type: "video" });
        expect(call[2]).not.toHaveProperty("caption");
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { messageText: "<b>New</b>", attachmentKinds: ["photo", "video"] });
        // text goes to the button message separately
        expect(api.editMessageText).toHaveBeenCalledWith(10, 103, "<b>New</b>", expect.anything());
    });

    it("replaces the single caption attachment together with caption and keyboard", async () => {
        findById.mockResolvedValue(broadcastRow({ textAsCaption: true, attachmentKinds: ["photo"] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        getMediaFileIds.mockResolvedValue({ [NEW_PHOTO]: "KNOWN" });
        await applyAnnouncementEdit(api, 7, command({ textAsCaption: true, replacements: [{ position: 0, attachment: attachment() }] }));
        expect(api.editMessageMedia).toHaveBeenCalledWith(
            10, 100,
            { type: "photo", media: "KNOWN", caption: "<b>New</b>", parse_mode: "HTML" },
            { reply_markup: { kb: "default", id: 7 } },
        );
        expect(api.editMessageCaption).not.toHaveBeenCalled();
        expect(openAttachment).not.toHaveBeenCalled();
    });

    it("remembers the file_id learned from the response", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        openAttachment.mockResolvedValue({ stream: { cancel: vi.fn().mockResolvedValue(undefined) } });
        api.editMessageMedia.mockResolvedValue({ message_id: 100, photo: [{ file_id: "LEARNED" }] });
        await applyAnnouncementEdit(api, 7, command({ replacements: [{ position: 0, attachment: attachment() }] }));
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { mediaFileIds: { [NEW_PHOTO]: "LEARNED" } });
    });

    it("fails with ATTACHMENT_UNAVAILABLE before touching any chat when the file is gone", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        openAttachment.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
        await expect(applyAnnouncementEdit(api, 7, command({ replacements: [{ position: 0, attachment: attachment() }] })))
            .rejects.toMatchObject({ code: "ATTACHMENT_UNAVAILABLE" });
        expect(api.editMessageMedia).not.toHaveBeenCalled();
    });
});

describe("applyAnnouncementEdit reconfirm", () => {
    const setup = () => {
        findById.mockResolvedValue(broadcastRow({
            trackedMessages: [tracked(10, 100, ["confirmed"]), tracked(20, 200, ["declined", "pending"])],
        }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100]), delivery(20, 200, [200])]);
    };

    it("resets answers and replies once per chat to the edited message with the keyboard", async () => {
        setup();
        const outcome = await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(outcome.reconfirmed).toBe(2);
        expect(replyUpdateMany).toHaveBeenCalledWith({ id: { in: [100] } }, { status: "pending", respondedAt: null });
        expect(replyUpdateMany).toHaveBeenCalledWith({ id: { in: [200] } }, { status: "pending", respondedAt: null });
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        expect(api.sendMessage).toHaveBeenCalledWith(10, RECONFIRM_PROMPT, {
            reply_parameters: { message_id: 100, allow_sending_without_reply: true },
            parse_mode: "HTML",
            reply_markup: { kb: "default", id: 7 },
        });
    });

    it("records the reconfirm message id in the delivery's partMessageIds", async () => {
        setup();
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(appendPart).toHaveBeenCalledWith(10, 900);
        expect(appendPart).toHaveBeenCalledWith(20, 900);
    });

    it("a repeat after partial progress does not message a chat that already got it", async () => {
        setup();
        claimMark.mockImplementation(async (_b: number, chatId: bigint) => chatId !== 10n);
        const outcome = await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(outcome.reconfirmed).toBe(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage.mock.calls[0]![0]).toBe(20);
    });

    it("without the checkbox nobody is notified and answers stay", async () => {
        setup();
        await applyAnnouncementEdit(api, 7, command());
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(replyUpdateMany).not.toHaveBeenCalled();
    });

    it("a failed send restores the answers and releases the mark", async () => {
        setup();
        api.sendMessage.mockRejectedValueOnce({ description: "Forbidden: bot was blocked by the user" });
        const outcome = await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(outcome.reconfirmed).toBe(1);
        expect(replyUpdate).toHaveBeenCalledWith(100, { status: "confirmed", respondedAt: new Date("2026-10-26T10:00:00Z") });
        expect(releaseMark).toHaveBeenCalledWith(10n, ACTION);
        expect(appendPart).toHaveBeenCalledTimes(1);
        expect(markDone).toHaveBeenCalled();
    });

    it("brings reminders back by the interval even when pings were cleared after everyone answered", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T11:00:00Z"));
        setup();
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(trackedUpdate).toHaveBeenCalledWith(10, { nextPingAt: new Date("2026-10-27T12:00:00Z") });
        vi.useRealTimers();
    });

    it("bot-origin tracked message without interval gets the default delay", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-10-27T08:00:00Z"));
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"], { pingIntervalMs: null })] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(trackedUpdate).toHaveBeenCalledWith(10, { nextPingAt: new Date("2026-10-27T14:00:00Z") });
        vi.useRealTimers();
    });

    it("a broadcast created without reminders does not get them", async () => {
        findById.mockResolvedValue(broadcastRow({ remindersEnabled: false, trackedMessages: [tracked(10, 100, ["confirmed"])] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(trackedUpdate).not.toHaveBeenCalled();
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("leaves reminders alone when stopped or past pingUntil", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        findById.mockResolvedValue(broadcastRow({ remindersStoppedAt: new Date(), trackedMessages: [tracked(10, 100, ["confirmed"])] }));
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        findLog.mockResolvedValue(null);
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"], { pingUntil: new Date("2020-01-01T00:00:00Z") })] }));
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(trackedUpdate).not.toHaveBeenCalled();
    });

    it("resumes reminders before the message goes out, so a crash after the reset still pings", async () => {
        setup();
        const order: string[] = [];
        trackedUpdate.mockImplementation(async () => { order.push("ping"); });
        api.sendMessage.mockImplementation(async () => { order.push("send"); return { message_id: 900 }; });
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(order.indexOf("ping")).toBeLessThan(order.indexOf("send"));
    });

    it("a failed send puts the previous nextPingAt back", async () => {
        const before = new Date("2026-10-27T20:00:00Z");
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"], { nextPingAt: before })] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        api.sendMessage.mockRejectedValue({ description: "Forbidden" });
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(trackedUpdate).toHaveBeenLastCalledWith(10, { nextPingAt: before });
    });
});

describe("applyAnnouncementEdit keyboard per delivery", () => {
    it("answered private chat without reconfirm: edit without reply_markup", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"])] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command());
        expect(api.editMessageText.mock.calls[0]![3]).not.toHaveProperty("reply_markup");
    });

    it("answered private chat without reconfirm: caption and caption-media edits carry no keyboard either", async () => {
        findById.mockResolvedValue(broadcastRow({ textAsCaption: true, trackedMessages: [tracked(10, 100, ["declined"])] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ textAsCaption: true }));
        expect(api.editMessageCaption.mock.calls[0]![2]).not.toHaveProperty("reply_markup");
        getMediaFileIds.mockResolvedValue({ [NEW_PHOTO]: "K" });
        findLog.mockResolvedValue(null);
        await applyAnnouncementEdit(api, 7, command({ textAsCaption: true, replacements: [{ position: 0, attachment: attachment() }] }));
        expect(api.editMessageMedia.mock.calls[0]![4]).toBeUndefined();
    });

    it("answered private chat with reconfirm: edit keeps the keyboard", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"])] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(api.editMessageText.mock.calls[0]![3]).toHaveProperty("reply_markup", { kb: "default", id: 7 });
    });

    it("private chat still waiting keeps the keyboard", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        await applyAnnouncementEdit(api, 7, command());
        expect(api.editMessageText.mock.calls[0]![3]).toHaveProperty("reply_markup");
    });
});

describe("applyAnnouncementEdit groups", () => {
    const group = (chatId: number, messageId: number) => ({ ...delivery(chatId, messageId, [messageId]), targetType: "GROUP" });

    it("group keeps the keyboard even when everyone answered, with the URL decline button from getMe", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(-100, 500, ["confirmed", "declined"])] }));
        findSentForEdit.mockResolvedValue([group(-100, 500)]);
        api.getMe.mockResolvedValue({ username: "PlayPhotoBot" });
        await applyAnnouncementEdit(api, 7, command());
        expect(buildKeyboardCalls[0]).toEqual(["default", 7, "PlayPhotoBot", true]);
        expect(api.editMessageText.mock.calls[0]![3]).toHaveProperty("reply_markup");
    });

    it("reconfirm in a group with several users: one message, all answers reset, group keyboard", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(-100, 500, ["confirmed", "declined", "pending", "confirmed"])] }));
        findSentForEdit.mockResolvedValue([group(-100, 500)]);
        api.getMe.mockResolvedValue({ username: "PlayPhotoBot" });
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(replyUpdateMany).toHaveBeenCalledWith({ id: { in: [-1000, -999, -997] } }, { status: "pending", respondedAt: null });
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage.mock.calls[0]![2]).toMatchObject({ reply_parameters: { message_id: 500 } });
        expect(buildKeyboardCalls.every(c => c[2] === "PlayPhotoBot" && c[3] === true)).toBe(true);
    });

    it("getMe failure is logged and falls back to the callback decline button", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(-100, 500, ["pending"])] }));
        findSentForEdit.mockResolvedValue([group(-100, 500)]);
        api.getMe.mockRejectedValue(new Error("network"));
        await applyAnnouncementEdit(api, 7, command());
        expect(loggerWarn).toHaveBeenCalled();
        expect(buildKeyboardCalls[0]).toEqual(["default", 7, undefined, true]);
        expect(api.editMessageText).toHaveBeenCalled();
    });
});

describe("applyAnnouncementEdit outcome", () => {
    it("one failed chat does not fail the command", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100]), delivery(20, 200, [200])]);
        api.editMessageText.mockRejectedValueOnce({ description: "Bad Request: chat not found" });
        const outcome = await applyAnnouncementEdit(api, 7, command());
        expect(outcome).toMatchObject({ edited: 1, failed: 1 });
        expect(markDone).toHaveBeenCalledWith(ACTION, 7, "EDIT", { edited: 1, failed: 1 });
    });

    it("fails when no chat succeeded and keeps the action open", async () => {
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100])]);
        api.editMessageText.mockRejectedValue({ description: "Forbidden" });
        await expect(applyAnnouncementEdit(api, 7, command())).rejects.toBeInstanceOf(AnnouncementEditFailure);
        expect(markDone).not.toHaveBeenCalled();
        expect(broadcastUpdate).not.toHaveBeenCalled();
    });

    it("with no deliveries still updates the stored text", async () => {
        await applyAnnouncementEdit(api, 7, command());
        expect(broadcastUpdate).toHaveBeenCalledWith(7, { messageText: "<b>New</b>" });
        expect(markDone).toHaveBeenCalled();
    });

    it("does not reconfirm a chat whose edit failed", async () => {
        findById.mockResolvedValue(broadcastRow({ trackedMessages: [tracked(10, 100, ["confirmed"]), tracked(20, 200, ["confirmed"])] }));
        findSentForEdit.mockResolvedValue([delivery(10, 100, [100]), delivery(20, 200, [200])]);
        api.editMessageText.mockRejectedValueOnce({ description: "Bad Request: chat not found" });
        await applyAnnouncementEdit(api, 7, command({ reconfirm: true }));
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage.mock.calls[0]![0]).toBe(20);
    });
});
