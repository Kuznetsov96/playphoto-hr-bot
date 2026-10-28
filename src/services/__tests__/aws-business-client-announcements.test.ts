import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

describe("AwsBusinessClient.putAnnouncementSnapshot", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const snapshot = { botBroadcastId: 7, source: "BOT" } as never;

    it("PUTs the JSON snapshot to /announcements/<id> under the base (no repeated internal/bot) and accepts 204", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().putAnnouncementSnapshot("pub id/1", snapshot)).resolves.toBeUndefined();

        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/announcements/pub%20id%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify(snapshot),
                signal: expect.any(AbortSignal),
                headers: expect.objectContaining({
                    authorization: `Bearer ${"a".repeat(32)}`,
                    "content-type": "application/json",
                }),
            }),
        );
    });

    it("uses a short timeout", async () => {
        const spy = vi.spyOn(AbortSignal, "timeout");
        vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await new AwsBusinessClient().putAnnouncementSnapshot("p", snapshot);

        expect(spy).toHaveBeenCalledWith(5_000);
    });

    it.each([400, 500])("throws AwsBusinessApiError on HTTP %i", async status => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: "X" }), { status }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().putAnnouncementSnapshot("p", snapshot))
            .rejects.toMatchObject({ status });
    });
});

describe("AwsBusinessClient announcement commands", () => {
    const ID = "11111111-1111-4111-8111-111111111111";
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("GETs the pending feed and parses SEND, TEST and unknown kinds per item", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
            items: [
                { kind: "SEND", publicId: ID, messageHtml: "<b>x</b>", replyMode: "CONFIRM", recipients: ["1"], reminders: null, authorName: null },
                { kind: "TEST", publicId: ID, telegramId: "5", messageHtml: "t", replyMode: "NONE" },
                { kind: "FUTURE", publicId: ID, extra: 1 },
            ],
        }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const result = await new AwsBusinessClient().listPendingAnnouncementCommands(20);

        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/announcements/commands/pending?limit=20",
            expect.objectContaining({ method: "GET" }),
        );
        expect(result.items.map(i => i.kind)).toEqual(["SEND", "TEST", "UNKNOWN"]);
    });

    it("POSTs accepted and failed acks to the command path", async () => {
        vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 204 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");
        const client = new AwsBusinessClient();

        await client.ackAnnouncementCommandAccepted(ID);
        await client.ackAnnouncementCommandFailed(ID, "BOT_BLOCKED");

        expect(fetch).toHaveBeenNthCalledWith(1,
            `https://api.example.test/api/v1/internal/bot/announcements/commands/${ID}/accepted`,
            expect.objectContaining({ method: "POST" }));
        expect(fetch).toHaveBeenNthCalledWith(2,
            `https://api.example.test/api/v1/internal/bot/announcements/commands/${ID}/failed`,
            expect.objectContaining({ method: "POST", body: JSON.stringify({ error: "BOT_BLOCKED" }) }));
    });

    it("parses REMIND, STOP, WITHDRAW and EDIT; a future kind stays UNKNOWN", async () => {
        const A = "22222222-2222-4222-8222-222222222222";
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
            items: [
                { kind: "REMIND", publicId: ID, announcementPublicId: A, notBefore: "2026-10-28T07:00:00.000Z" },
                { kind: "STOP", publicId: ID, announcementPublicId: A, actorName: "Olha" },
                { kind: "WITHDRAW", publicId: ID, announcementPublicId: A, actorName: "Olha" },
                { kind: "EDIT", publicId: ID, announcementPublicId: A, messageHtml: "x", reconfirm: true, textAsCaption: false, replacements: [], actorName: "Olha" },
                { kind: "FUTURE_ACTION", publicId: ID },
            ],
        }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const result = await new AwsBusinessClient().listPendingAnnouncementCommands(20);

        expect(result.items.map(i => i.kind)).toEqual(["REMIND", "STOP", "WITHDRAW", "EDIT", "UNKNOWN"]);
    });

    it("sends the WITHDRAW result in the accepted body", async () => {
        vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 204 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await new AwsBusinessClient().ackAnnouncementCommandAccepted(ID, { deletedChats: 3, stayed: ["10"] });

        expect(fetch).toHaveBeenCalledWith(
            `https://api.example.test/api/v1/internal/bot/announcements/commands/${ID}/accepted`,
            expect.objectContaining({ body: JSON.stringify({ result: { deletedChats: 3, stayed: ["10"] } }) }));
    });
});

describe("AwsBusinessClient announcement recipients", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("reads the catalogue", async () => {
        const body = { cities: [{ name: "Kyiv", peopleCount: 3, locations: [{ publicId: "l1", name: "Mall", peopleCount: 2 }] }], everyoneCount: 5 };
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().getAnnouncementRecipientCatalogue()).resolves.toEqual(body);
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/announcements/recipients/catalogue",
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("resolves a selection with a POST body", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ count: 2, telegramIds: ["1", "2"] }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");
        const selection = { everyone: false, cityNames: ["Kyiv"], locationPublicIds: [] };

        await expect(new AwsBusinessClient().resolveAnnouncementRecipients(selection)).resolves.toEqual({ count: 2, telegramIds: ["1", "2"] });
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/announcements/recipients/resolve",
            expect.objectContaining({ method: "POST", body: JSON.stringify(selection) }),
        );
    });
});
