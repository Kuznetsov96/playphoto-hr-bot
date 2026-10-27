import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import type { BroadcastMediaItem } from "../../types/context.js";
import { AnnouncementPartsError, sendAnnouncementParts } from "../announcement-parts.js";

const KB = { inline_keyboard: [[{ text: "ok", callback_data: "x" }]] };
const extra = { parse_mode: "HTML", reply_markup: KB };

const item = (type: BroadcastMediaItem["type"], n: number, more: Partial<BroadcastMediaItem> = {}): BroadcastMediaItem => ({
    type, fileId: "", attachmentPublicId: `att-${n}`, fileName: `f${n}`, ...more,
});
const photo = (n: number) => item("photo", n);
const doc = (n: number) => item("document", n);

let nextId = 100;
const photoMsg = (n: number) => ({ message_id: nextId++, photo: [{ file_id: `small-${n}` }, { file_id: `big-${n}` }] });
const docMsg = (n: number) => ({ message_id: nextId++, document: { file_id: `doc-${n}` } });

const makeApi = () => ({
    sendPhoto: vi.fn(async (..._args: any[]) => photoMsg(1)),
    sendVideo: vi.fn(async (..._args: any[]) => ({ message_id: nextId++, video: { file_id: "vid-1" } })),
    sendDocument: vi.fn(async (..._args: any[]) => docMsg(1)),
    sendMediaGroup: vi.fn(async (_c: number, group: Array<{ type: string }>, ..._rest: any[]) =>
        group.map((g, i) => (g.type === "photo" ? photoMsg(i + 1) : g.type === "document" ? docMsg(i + 1) : { message_id: nextId++, video: { file_id: `vid-${i + 1}` } }))),
    sendMessage: vi.fn(async (..._args: any[]) => ({ message_id: nextId++ })),
});

const openAttachment = vi.fn();
const run = (api: ReturnType<typeof makeApi>, over: Partial<Parameters<typeof sendAnnouncementParts>[2]> & { media?: BroadcastMediaItem[]; documents?: BroadcastMediaItem[] }) =>
    sendAnnouncementParts(api, 5, {
        text: "Привіт", media: [], documents: [], textAsCaption: false, extra, buttonType: "default",
        fileIds: {}, openAttachment, followUpText: bt => `follow-${bt}`, ...over,
    });

describe("sendAnnouncementParts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nextId = 100;
        openAttachment.mockImplementation(async () => ({ stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }));
    });

    it("one attachment as caption: ONE message with caption and buttons", async () => {
        const api = makeApi();
        const r = await run(api, { media: [photo(1)], textAsCaption: true });
        expect(api.sendPhoto).toHaveBeenCalledTimes(1);
        const [chat, file, options] = api.sendPhoto.mock.calls[0] as unknown as [number, unknown, Record<string, unknown>];
        expect(chat).toBe(5);
        expect(file).toBeInstanceOf(InputFile);
        expect(options).toMatchObject({ caption: "Привіт", parse_mode: "HTML", reply_markup: KB });
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(r.partMessageIds).toEqual([100]);
        expect(r.buttonMessage?.message_id).toBe(100);
        expect(r.learnedFileIds).toEqual({ "att-1": "big-1" });
    });

    it("caption mode with empty text: no caption, buttons stay", async () => {
        const api = makeApi();
        await run(api, { text: "", media: [photo(1)], textAsCaption: true });
        const options = (api.sendPhoto.mock.calls[0] as unknown as [number, unknown, Record<string, unknown>])[2];
        expect(options).not.toHaveProperty("caption");
        expect(options.reply_markup).toBe(KB);
    });

    it("obeys textAsCaption=false even for a short text: attachment, then text with buttons", async () => {
        const api = makeApi();
        const r = await run(api, { media: [photo(1)], textAsCaption: false });
        expect(api.sendPhoto.mock.calls[0]?.[2]).toEqual({});
        expect(api.sendMessage).toHaveBeenCalledWith(5, "Привіт", extra);
        expect(r.partMessageIds).toHaveLength(2);
        expect(r.buttonMessage?.message_id).toBe(r.partMessageIds[1]);
    });

    it("photo + long text: photo has no buttons, text carries them", async () => {
        const api = makeApi();
        await run(api, { text: "x".repeat(2000), media: [photo(1)] });
        expect(JSON.stringify(api.sendPhoto.mock.calls[0]?.[2])).not.toContain("reply_markup");
        expect(api.sendMessage.mock.calls[0]?.[2]).toBe(extra);
    });

    it("2-10 media go as ONE album without buttons, then text with buttons", async () => {
        const api = makeApi();
        const r = await run(api, { media: [photo(1), photo(2), photo(3)] });
        expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
        const group = api.sendMediaGroup.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
        expect(group.map(g => g.type)).toEqual(["photo", "photo", "photo"]);
        expect(group.every(g => !("reply_markup" in g) && !("caption" in g))).toBe(true);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(r.partMessageIds).toHaveLength(4);
        expect(r.learnedFileIds).toEqual({ "att-1": "big-1", "att-2": "big-2", "att-3": "big-3" });
    });

    it("1 document: sendDocument; 2 documents: album of documents", async () => {
        const one = makeApi();
        await run(one, { documents: [doc(1)] });
        expect(one.sendDocument).toHaveBeenCalledTimes(1);
        const two = makeApi();
        await run(two, { documents: [doc(1), doc(2)] });
        expect(two.sendMediaGroup).toHaveBeenCalledTimes(1);
        expect((two.sendMediaGroup.mock.calls[0]?.[1] as Array<{ type: string }>).map(g => g.type)).toEqual(["document", "document"]);
    });

    it("photo + file: media, then document, then text, in order", async () => {
        const api = makeApi();
        const order: string[] = [];
        api.sendPhoto.mockImplementation(async () => { order.push("photo"); return photoMsg(1); });
        api.sendDocument.mockImplementation(async () => { order.push("doc"); return docMsg(1); });
        api.sendMessage.mockImplementation(async () => { order.push("text"); return { message_id: nextId++ }; });
        await run(api, { media: [photo(1)], documents: [doc(2)] });
        expect(order).toEqual(["photo", "doc", "text"]);
    });

    it("empty text: CONFIRM sends the follow-up with buttons, NONE sends nothing after attachments", async () => {
        const confirm = makeApi();
        await run(confirm, { text: "", media: [photo(1)] });
        expect(confirm.sendMessage).toHaveBeenCalledWith(5, "follow-default", extra);
        const none = makeApi();
        const r = await run(none, { text: "", media: [photo(1)], buttonType: "none", extra: { parse_mode: "HTML" } });
        expect(none.sendMessage).not.toHaveBeenCalled();
        expect(r.buttonMessage).toBeNull();
        expect(r.partMessageIds).toHaveLength(1);
    });

    it("video carries width, height, duration and supports_streaming", async () => {
        const api = makeApi();
        await run(api, { media: [item("video", 1, { width: 1920, height: 1080, durationSec: 12 })], text: "" , buttonType: "none"});
        expect(api.sendVideo.mock.calls[0]?.[2]).toMatchObject({ supports_streaming: true, width: 1920, height: 1080, duration: 12 });
        const album = makeApi();
        await run(album, { media: [item("video", 1, { width: 10, height: 20, durationSec: 3 }), photo(2)] });
        expect(album.sendMediaGroup.mock.calls[0]?.[1]?.[0]).toMatchObject({ type: "video", supports_streaming: true, width: 10, height: 20, duration: 3 });
    });

    it("known file_id is used as is and the stream is never opened", async () => {
        const api = makeApi();
        const r = await run(api, { media: [photo(1)], fileIds: { "att-1": "cached" } });
        expect(api.sendPhoto.mock.calls[0]?.[1]).toBe("cached");
        expect(openAttachment).not.toHaveBeenCalled();
        expect(r.learnedFileIds).toEqual({});
    });

    it("failure on the text after an album keeps the album ids and learned file ids", async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(new Error("Forbidden: bot was blocked"));
        const error = await run(api, { media: [photo(1), photo(2)] }).catch(e => e);
        expect(error).toBeInstanceOf(AnnouncementPartsError);
        expect(error.partMessageIds).toHaveLength(2);
        expect(error.learnedFileIds).toEqual({ "att-1": "big-1", "att-2": "big-2" });
        expect(error.message).toContain("blocked");
    });
});
