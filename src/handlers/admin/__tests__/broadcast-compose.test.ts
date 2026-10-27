import { beforeEach, describe, expect, it, vi } from "vitest";

const renderScreen = vi.fn();
const goBack = vi.fn();
const createBotAnnouncement = vi.fn();
const sendTestBroadcast = vi.fn();
const resolveRecipients = vi.fn();
const getCatalogue = vi.fn();
const getRole = vi.fn();

vi.mock("../../../services/broadcast.js", () => ({ broadcastService: { createBotAnnouncement, sendTestBroadcast, withdrawBroadcast: vi.fn(), getStats: vi.fn() } }));
vi.mock("../../../services/aws-business-client.js", () => ({
    awsBusinessClient: { resolveAnnouncementRecipients: resolveRecipients, getAnnouncementRecipientCatalogue: getCatalogue },
}));
vi.mock("../../../repositories/user-repository.js", () => ({
    userRepository: { findWithStaffProfileByTelegramId: vi.fn().mockResolvedValue({ firstName: "Ira", lastName: "K", username: null, staffProfile: { fullName: "Ira Kovalenko" } }) },
}));
vi.mock("../../../middleware/role-check.js", () => ({ getUserAdminRole: getRole }));
vi.mock("../../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen, goBack } }));

const { startStatelessBroadcast, handleBroadcastContent, broadcastComposeHandlers } = await import("../broadcast-compose.js");
const { nightLine, describeArrival } = await import("../broadcast-helpers.js");
const { getMessageHtml } = await import("../utils.js");

const LOC_A = "11111111-1111-4111-8111-111111111111";
const LOC_B = "22222222-2222-4222-8222-222222222222";
const catalogue = {
    everyoneCount: 50,
    cities: [
        { name: "Kyiv", peopleCount: 20, locations: [{ publicId: LOC_A, name: "Dragon", peopleCount: 12 }] },
        { name: "Lviv", peopleCount: 14, locations: [{ publicId: LOC_B, name: "Leoland", peopleCount: 14 }] },
    ],
};

function makeCtx(session: any = {}) {
    const ctx: any = {
        api: { sendMessage: vi.fn() },
        from: { id: 99 },
        chat: { id: 99, type: "private" },
        session,
        update: { update_id: 1 },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue({ message_id: 1 }),
        deleteMessage: vi.fn().mockResolvedValue(true),
    };
    return ctx;
}

/** Нажать кнопку: гоним callback_query через композер. */
async function tap(ctx: any, data: string) {
    ctx.callbackQuery = { id: "q", data, message: { message_id: 5 } };
    ctx.update = { update_id: 1, callback_query: ctx.callbackQuery };
    ctx.message = undefined;
    await broadcastComposeHandlers.middleware()(ctx, async () => { });
}

const lastScreen = () => {
    const call = renderScreen.mock.calls.at(-1)!;
    return { text: call[1] as string, kb: call[2] as any };
};
const labels = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.text);
const allLabels = (): string[] => renderScreen.mock.calls.flatMap(c => labels(c[2]));

async function send(ctx: any, message: any) {
    ctx.callbackQuery = undefined;
    ctx.message = { message_id: 7, ...message };
    return handleBroadcastContent(ctx);
}

async function toMessageStep(ctx: any, reply: "none" | "confirm" = "none") {
    await startStatelessBroadcast(ctx);
    await tap(ctx, "br_to_all");
    if (reply === "none") await tap(ctx, "br_reply_none");
    else { await tap(ctx, "br_reply_confirm"); await tap(ctx, "br_reply_next"); }
}

beforeEach(() => {
    vi.clearAllMocks();
    getRole.mockResolvedValue("SUPER_ADMIN");
    getCatalogue.mockResolvedValue(catalogue);
    resolveRecipients.mockResolvedValue({ count: 34, telegramIds: [] });
    createBotAnnouncement.mockResolvedValue({ broadcastId: 5, publicId: "pub", count: 35 });
    sendTestBroadcast.mockResolvedValue({ message_id: 1 });
});

describe("To step", () => {
    it("offers Everyone, By city, By location, Cancel", async () => {
        await startStatelessBroadcast(makeCtx());
        expect(labels(lastScreen().kb)).toEqual(["Everyone", "By city", "By location", "Cancel"]);
    });

    it("By city multiselects with a check mark, counts people and offers Continue (n)", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_city");
        expect(labels(lastScreen().kb)).toEqual(["Kyiv", "Lviv", "Back"]);
        await tap(ctx, "br_tc_0");
        await tap(ctx, "br_tc_1");
        expect(labels(lastScreen().kb)).toEqual(["✓ Kyiv", "✓ Lviv", "Continue (2)", "Back"]);
        expect(lastScreen().text).toContain("34 people will get it");
        expect(resolveRecipients).toHaveBeenLastCalledWith({ everyone: false, cityNames: ["Kyiv", "Lviv"], locationPublicIds: [] });
        await tap(ctx, "br_tc_0");
        expect(labels(lastScreen().kb)).toEqual(["Kyiv", "✓ Lviv", "Continue (1)", "Back"]);
    });

    it("a city tap uses the list shown, not a freshly loaded catalogue", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_city");
        getCatalogue.mockClear();
        getCatalogue.mockResolvedValue({ ...catalogue, cities: [catalogue.cities[1], catalogue.cities[0]] });
        await tap(ctx, "br_tc_0");
        expect(ctx.session.broadcastData.cityNames).toEqual(["Kyiv"]);
        expect(getCatalogue).toHaveBeenCalledTimes(1);
    });

    it("By location selects by public id", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_loc");
        await tap(ctx, `br_tl_${LOC_B}`);
        expect(labels(lastScreen().kb)).toContain("✓ Leoland (Lviv)");
        expect(resolveRecipients).toHaveBeenLastCalledWith({ everyone: false, cityNames: [], locationPublicIds: [LOC_B] });
        await tap(ctx, "br_sel_next");
        expect(labels(lastScreen().kb)).toEqual(["Ask to confirm", "No reply needed", "Back"]);
    });

    it("a selection nobody matches cannot continue", async () => {
        resolveRecipients.mockResolvedValue({ count: 0, telegramIds: [] });
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_city");
        await tap(ctx, "br_tc_0");
        expect(labels(lastScreen().kb)).not.toContain("Continue (1)");
        expect(lastScreen().text).toContain("No one will get it.");
    });

    it("Cancel clears the draft", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_cancel");
        expect(ctx.session.broadcastData).toBeUndefined();
        expect(ctx.session.adminFlow).toBeUndefined();
        expect(ctx.answerCallbackQuery).toHaveBeenLastCalledWith("Cancelled.");
        expect(goBack).toHaveBeenCalledWith(ctx, expect.any(String), "admin-broadcast-hub");
    });
});

describe("Reply step", () => {
    it("Ask to confirm shows the Reminders toggle and Continue", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_all");
        await tap(ctx, "br_reply_confirm");
        expect(labels(lastScreen().kb)).toEqual(["Reminders: On", "Continue", "Back"]);
        await tap(ctx, "br_rem_toggle");
        expect(labels(lastScreen().kb)[0]).toBe("Reminders: Off");
        await tap(ctx, "br_reply_next");
        expect(lastScreen().text).toContain("Send the text and attachments. Photos and videos — up to 10, files — up to 10.");
    });

    it("Back on the reminders screen returns to the reply choice", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_all");
        await tap(ctx, "br_reply_confirm");
        const back = lastScreen().kb.inline_keyboard.flat().find((b: any) => b.text === "Back");
        await tap(ctx, back.callback_data);
        expect(labels(lastScreen().kb)).toEqual(["Ask to confirm", "No reply needed", "Back"]);
    });

    it("No reply needed goes straight to the message", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        expect(ctx.session.broadcastData.replyMode).toBe("NONE");
        expect(ctx.session.broadcastData.step).toBe("MESSAGE");
    });
});

describe("Message step", () => {
    it("shows counters and Continue / Clear / Back", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        expect(labels(lastScreen().kb)).toEqual(["Continue", "Clear", "Back"]);
        expect(lastScreen().text).toContain("Photos and videos: 0 of 10 · Files: 0 of 10");
    });

    it("counts photos, videos and files", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        for (let i = 0; i < 3; i++) await send(ctx, { photo: [{ file_id: `s${i}`, width: 1, height: 1 }, { file_id: `p${i}`, width: 9, height: 9 }] });
        await send(ctx, { document: { file_id: "d1", file_name: "a.pdf" } });
        expect(lastScreen().text).toContain("Photos and videos: 3 of 10 · Files: 1 of 10");
        expect(ctx.session.broadcastData.media.map((m: any) => m.fileId)).toEqual(["p0", "p1", "p2", "d1"]);
    });

    it("refuses the eleventh photo and the eleventh file, keeps the rest", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        for (let i = 0; i < 11; i++) await send(ctx, { photo: [{ file_id: `p${i}`, width: 1, height: 1 }] });
        expect(ctx.session.broadcastData.media).toHaveLength(10);
        expect(lastScreen().text).toContain("Photos and videos: up to 10");
        for (let i = 0; i < 11; i++) await send(ctx, { document: { file_id: `d${i}` } });
        expect(ctx.session.broadcastData.media).toHaveLength(20);
        expect(lastScreen().text).toContain("Files: up to 10");
    });

    it.each(["voice", "video_note", "audio", "animation"])("refuses %s", async (kind) => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { [kind]: { file_id: "x" } });
        expect(ctx.reply).toHaveBeenCalledWith("This type isn't supported. Send it as a file.");
        expect(ctx.session.broadcastData.media).toHaveLength(0);
    });

    it("refuses a sticker on the message step only (own handler, not the shared filter)", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        ctx.callbackQuery = undefined;
        ctx.message = { message_id: 7, sticker: { file_id: "s" } };
        ctx.update = { update_id: 2, message: ctx.message };
        const next = vi.fn();
        await broadcastComposeHandlers.middleware()(ctx, next);
        expect(ctx.reply).toHaveBeenCalledWith("This type isn't supported. Send it as a file.");
        expect(next).not.toHaveBeenCalled();
        const other = makeCtx({});
        other.message = { message_id: 8, sticker: { file_id: "s" } };
        other.update = { update_id: 3, message: other.message };
        const next2 = vi.fn();
        await broadcastComposeHandlers.middleware()(other, next2);
        expect(next2).toHaveBeenCalled();
        expect(other.reply).not.toHaveBeenCalled();
    });

    it("refuses text over 4096 with the numbers", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "a".repeat(4097) });
        expect(ctx.reply.mock.calls[0]![0]).toContain("4097 of 4096");
        expect(ctx.session.broadcastData.textHtml).toBeUndefined();
    });

    it("accepts exactly 4096", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "a".repeat(4096) });
        expect(ctx.session.broadcastData.textHtml).toHaveLength(4096);
    });

    it("an album sent in one go is collected whole with its caption and entities", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { media_group_id: "g", photo: [{ file_id: "a", width: 1, height: 1 }], caption: "Hello team", caption_entities: [{ type: "bold", offset: 0, length: 5 }] });
        await send(ctx, { media_group_id: "g", photo: [{ file_id: "b", width: 1, height: 1 }] });
        await send(ctx, { media_group_id: "g", video: { file_id: "c", width: 2, height: 2, duration: 3 } });
        expect(ctx.session.broadcastData.media.map((m: any) => m.fileId)).toEqual(["a", "b", "c"]);
        expect(ctx.session.broadcastData.textHtml).toBe("<b>Hello</b> team");
        expect(lastScreen().text).toContain("Photos and videos: 3 of 10");
    });

    it("a 10-part album sends one new screen and edits it for the rest", async () => {
        renderScreen.mockImplementation(async (c: any) => { (c.session.messagesToDelete ??= []).push(500); });
        const ctx = makeCtx();
        ctx.api.editMessageText = vi.fn().mockResolvedValue(true);
        await toMessageStep(ctx);
        renderScreen.mockClear();
        for (let i = 0; i < 10; i++) await send(ctx, { media_group_id: "g", photo: [{ file_id: `p${i}`, width: 1, height: 1 }] });
        expect(renderScreen).toHaveBeenCalledTimes(1);
        expect(ctx.api.editMessageText).toHaveBeenCalledTimes(9);
        expect(ctx.api.editMessageText.mock.calls.at(-1)![0]).toBe(99);
        expect(ctx.api.editMessageText.mock.calls.at(-1)![1]).toBe(500);
        expect(ctx.api.editMessageText.mock.calls.at(-1)![2]).toContain("Photos and videos: 10 of 10");
        expect(ctx.session.broadcastData.media).toHaveLength(10);
        renderScreen.mockReset();
    });

    it("Clear drops text and attachments; Continue needs content", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await tap(ctx, "br_msg_next");
        expect(ctx.answerCallbackQuery).toHaveBeenLastCalledWith("Add text or an attachment first.");
        await send(ctx, { text: "hi" });
        await tap(ctx, "br_msg_clear");
        expect(ctx.session.broadcastData.textHtml).toBeUndefined();
        expect(ctx.session.broadcastData.media).toEqual([]);
    });

    it("ignores content outside the message step and for non-admins", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        expect(await send(ctx, { text: "x" })).toBe(false);
        await tap(ctx, "br_to_all");
        await tap(ctx, "br_reply_none");
        getRole.mockResolvedValue("STAFF");
        expect(await send(ctx, { text: "x" })).toBe(false);
    });
});

describe("formatting survives to createBotAnnouncement", () => {
    const e = (type: string, length: number, extra: object = {}) => ({ type, offset: 0, length, ...extra });
    const cases: Array<[string, any, string]> = [
        ["bold", e("bold", 4), "<b>abcd</b> ef"],
        ["italic", e("italic", 4), "<i>abcd</i> ef"],
        ["underline", e("underline", 4), "<u>abcd</u> ef"],
        ["strikethrough", e("strikethrough", 4), "<s>abcd</s> ef"],
        ["spoiler", e("spoiler", 4), "<tg-spoiler>abcd</tg-spoiler> ef"],
        ["code", e("code", 4), "<code>abcd</code> ef"],
        ["pre", e("pre", 4), "<pre>abcd</pre> ef"],
        ["pre with language", e("pre", 4, { language: "ts" }), '<pre><code class="language-ts">abcd</code></pre> ef'],
        ["blockquote", e("blockquote", 4), "<blockquote>abcd</blockquote> ef"],
        ["expandable blockquote", e("expandable_blockquote", 4), "<blockquote expandable>abcd</blockquote> ef"],
        ["text_link", e("text_link", 4, { url: "https://example.com/?a=1&b=2" }), '<a href="https://example.com/?a=1&amp;b=2">abcd</a> ef'],
        ["text_mention", e("text_mention", 4, { user: { id: 77 } }), '<a href="tg://user?id=77">abcd</a> ef'],
        ["date_time", e("date_time", 4, { unix_time: 1647531900, date_time_format: "wDT" }), '<tg-time unix="1647531900" format="wDT">abcd</tg-time> ef'],
        ["date_time without format", e("date_time", 4, { unix_time: 1647531900 }), '<tg-time unix="1647531900">abcd</tg-time> ef'],
        ["custom_emoji stays plain", e("custom_emoji", 4, { custom_emoji_id: "1" }), "abcd ef"],
    ];

    it.each(cases)("%s (text)", async (_name, entity, html) => {
        expect(getMessageHtml({ text: "abcd ef", entities: [entity] } as any)).toBe(html);
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "abcd ef", entities: [entity] });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_send");
        expect(createBotAnnouncement.mock.calls[0]![2].textHtml).toBe(html);
    });

    it.each(cases)("%s (caption)", async (_name, entity, html) => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { photo: [{ file_id: "p", width: 1, height: 1 }], caption: "abcd ef", caption_entities: [entity] });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_send");
        expect(createBotAnnouncement.mock.calls[0]![2].textHtml).toBe(html);
    });
});

describe("Preview and send", () => {
    it("shows the arrival line, count and the buttons", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx, "confirm");
        await send(ctx, { photo: [{ file_id: "p", width: 1, height: 1 }], caption: "Short" });
        await tap(ctx, "br_msg_next");
        const { text, kb } = lastScreen();
        expect(text).toContain("Arrives as 1 message.");
        expect(text).toContain("Ask to confirm · Reminders: On");
        expect(text).toContain("34 people will get it");
        expect(labels(kb)).toEqual(["Send test to me", "Send to 34 people", "Back", "Cancel"]);
    });

    it("lists the parts when the layout splits (album + file + text with buttons)", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx, "confirm");
        await send(ctx, { photo: [{ file_id: "a", width: 1, height: 1 }] });
        await send(ctx, { photo: [{ file_id: "b", width: 1, height: 1 }] });
        await send(ctx, { document: { file_id: "d" } });
        await send(ctx, { text: "Body" });
        await tap(ctx, "br_msg_next");
        expect(lastScreen().text).toContain("Arrives as 3 messages: album, file, then the text with reply buttons.");
    });

    it("describeArrival mirrors the webapp words", () => {
        expect(describeArrival({ textAsCaption: false, parts: ["photo_or_video", "text"] }, { singleMediaKind: "video" })).toBe("Arrives as 2 messages: video, then the text.");
        expect(describeArrival({ textAsCaption: false, parts: ["album", "follow_up"] }, { replyMode: "CONFIRM" })).toBe("Arrives as 2 messages: album, then a confirm line with reply buttons.");
    });

    it("night line appears only in quiet hours (Kyiv)", () => {
        expect(nightLine(new Date("2026-10-27T21:10:00Z"))).toBe("It's 23:10 — people may be asleep.");
        expect(nightLine(new Date("2026-10-27T10:00:00Z"))).toBeNull();
    });

    it("Preview carries the night line when it is night", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-27T21:10:00Z"));
        try {
            const ctx = makeCtx();
            await toMessageStep(ctx);
            await send(ctx, { text: "Hi" });
            await tap(ctx, "br_msg_next");
            expect(lastScreen().text).toContain("It's 23:10 — people may be asleep.");
        } finally { vi.useRealTimers(); }
    });

    it("Send test to me goes to the admin only, with the same layout flag", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx, "confirm");
        await send(ctx, { photo: [{ file_id: "p", width: 1, height: 1 }], caption: "Short" });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_test");
        expect(sendTestBroadcast).toHaveBeenCalledTimes(1);
        const args = sendTestBroadcast.mock.calls[0]!;
        expect(args[1]).toBe(99);
        expect(args[2]).toBe("Short");
        expect(args[4]).toBe("default");
        expect(args[5]).toBe(true);
        expect(args[6]).toBe(true);
        expect(createBotAnnouncement).not.toHaveBeenCalled();
        // Предпросмотр перерисован ниже тестовых сообщений.
        const call = renderScreen.mock.calls.at(-1)!;
        expect(call[1]).toContain("<b>Preview</b>");
        expect(call[3]).toEqual({ forceNew: true });
        expect(labels(call[2])).toContain("Send to 34 people");
    });

    it("a failed test shows the reason on the redrawn Preview", async () => {
        sendTestBroadcast.mockRejectedValue(new Error("boom"));
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "Hi" });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_test");
        const call = renderScreen.mock.calls.at(-1)!;
        expect(call[1]).toContain("<b>Preview</b>");
        expect(call[1]).toContain("Couldn't send the test: boom");
        expect(call[3]).toEqual({ forceNew: true });
    });

    it("Send creates the announcement with the exact fields and shows the result", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_city");
        await tap(ctx, "br_tc_1");
        await tap(ctx, "br_sel_next");
        await tap(ctx, "br_reply_confirm");
        await tap(ctx, "br_rem_toggle");
        await tap(ctx, "br_reply_next");
        await send(ctx, { video: { file_id: "v", file_name: "v.mp4", width: 4, height: 3, duration: 9 }, caption: "Go" });
        await send(ctx, { document: { file_id: "d", file_name: "a.pdf", mime_type: "application/pdf" } });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_send");
        expect(createBotAnnouncement).toHaveBeenCalledWith(
            ctx.api,
            { telegramId: 99, name: "Ira Kovalenko" },
            {
                target: { everyone: false, cityNames: ["Lviv"], locationPublicIds: [] },
                replyMode: "CONFIRM",
                reminders: false,
                textHtml: "Go",
                media: [
                    { kind: "video", fileId: "v", fileName: "v.mp4", width: 4, height: 3, durationSec: 9 },
                    { kind: "document", fileId: "d", fileName: "a.pdf" },
                ],
            },
        );
        const { text, kb } = lastScreen();
        expect(text).toBe("Sent to 35 people.");
        expect(labels(kb)).toEqual(["New announcement", "Back to announcements"]);
        expect(ctx.session.broadcastData).toBeUndefined();
    });

    it("reminders are off when no reply is asked", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "Hi" });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_send");
        const input = createBotAnnouncement.mock.calls[0]![2];
        expect(input.replyMode).toBe("NONE");
        expect(input.reminders).toBe(false);
        expect(input.target).toEqual({ everyone: true, cityNames: [], locationPublicIds: [] });
    });

    it("a stale Send button without a draft does nothing", async () => {
        const ctx = makeCtx();
        await tap(ctx, "b_send");
        expect(createBotAnnouncement).not.toHaveBeenCalled();
    });

    it("a non-admin cannot send", async () => {
        const ctx = makeCtx();
        await toMessageStep(ctx);
        await send(ctx, { text: "Hi" });
        await tap(ctx, "br_msg_next");
        getRole.mockResolvedValue(null);
        await tap(ctx, "b_send");
        expect(createBotAnnouncement).not.toHaveBeenCalled();
    });
});

describe("button labels", () => {
    it("no admin keyboard label of the flow contains an emoji", async () => {
        const ctx = makeCtx();
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_to_city");
        await tap(ctx, "br_tc_0");
        await tap(ctx, "br_to_back");
        await tap(ctx, "br_to_loc");
        await tap(ctx, `br_tl_${LOC_A}`);
        await tap(ctx, "br_sel_next");
        await tap(ctx, "br_reply_confirm");
        await tap(ctx, "br_rem_toggle");
        await tap(ctx, "br_reply_next");
        await send(ctx, { text: "Hi" });
        await tap(ctx, "br_msg_next");
        await tap(ctx, "b_send");
        await startStatelessBroadcast(ctx);
        await tap(ctx, "br_cancel");
        const found = allLabels();
        expect(found.length).toBeGreaterThan(20);
        for (const label of found) expect(label, label).not.toMatch(/\p{Extended_Pictographic}/u);
    });
});
