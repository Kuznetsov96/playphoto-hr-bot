import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

/**
 * Полный цикл найма (фаза 3b): переписка рекрутёр ↔ кандидатка и рассылки по
 * пулу города. Те же принципы, что и у команд: схемы НЕ `.strict()`, новое
 * поле в ответе API не должно ронять доставку (см. историю .strict() и
 * сохранения побажань).
 */
describe("AwsBusinessClient recruiting loop endpoints", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const messageRow = {
        publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        body: "Привіт!",
        telegramId: "1164289764",
    };

    describe("listPendingRecruitingMessages", () => {
        it("GETs /recruiting/messages/pending с лимитом и разбирает items", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ items: [{ ...messageRow, addedLater: 1 }] }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().listPendingRecruitingMessages(50);

            expect(result).toEqual({ items: [expect.objectContaining(messageRow)] });
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/messages/pending?limit=50",
                expect.objectContaining({ method: "GET" }),
            );
        });
    });

    describe("ackRecruitingMessageSent", () => {
        it("POSTs telegramMessageId на /recruiting/messages/:publicId/sent", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: messageRow.publicId, status: "SENT" }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().ackRecruitingMessageSent(messageRow.publicId, "42");

            expect(result).toEqual({ publicId: messageRow.publicId, status: "SENT" });
            expect(fetch).toHaveBeenCalledWith(
                `https://api.example.test/api/v1/internal/bot/recruiting/messages/${messageRow.publicId}/sent`,
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ telegramMessageId: "42" }),
                }),
            );
        });
    });

    describe("ackRecruitingMessageFailed", () => {
        it("режет причину до контрактных 500 символов", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: messageRow.publicId, status: "FAILED" }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await new AwsBusinessClient().ackRecruitingMessageFailed(messageRow.publicId, "x".repeat(600));

            const [url, init] = vi.mocked(fetch).mock.calls[0]!;
            expect(url).toBe(`https://api.example.test/api/v1/internal/bot/recruiting/messages/${messageRow.publicId}/failed`);
            const body = JSON.parse((init as RequestInit).body as string) as { error: string };
            expect(body.error).toHaveLength(500);
        });
    });

    describe("pushIncomingRecruitingMessage", () => {
        it("POSTs входящее на /recruiting/messages/incoming", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: "m-1", direction: "IN", status: "RECEIVED" }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await new AwsBusinessClient().pushIncomingRecruitingMessage({
                telegramId: "1164289764",
                body: "Питання",
                telegramMessageId: "55",
                sentAt: "2026-08-27T12:00:00.000Z",
            });

            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/messages/incoming",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        telegramId: "1164289764",
                        body: "Питання",
                        telegramMessageId: "55",
                        sentAt: "2026-08-27T12:00:00.000Z",
                    }),
                }),
            );
        });
    });

    describe("listPendingRecruitingBroadcasts", () => {
        it("GETs /recruiting/broadcasts/pending и разбирает items со stages", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({
                    items: [{ publicId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", city: "Київ", body: "Текст" }],
                    stages: ["SCREENING", "WAITLIST"],
                }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().listPendingRecruitingBroadcasts();

            expect(result).toEqual({
                items: [expect.objectContaining({ city: "Київ" })],
                stages: ["SCREENING", "WAITLIST"],
            });
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/broadcasts/pending",
                expect.objectContaining({ method: "GET" }),
            );
        });
    });

    describe("ackRecruitingBroadcastDone / Failed", () => {
        it("POSTs счётчики на /recruiting/broadcasts/:publicId/done", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: "b-1", status: "APPLIED", sentCount: 3, failedCount: 1 }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await new AwsBusinessClient().ackRecruitingBroadcastDone("7c9e6679-7425-40de-944b-e07fc1f90ae7", { sent: 3, failed: 1 });

            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/broadcasts/7c9e6679-7425-40de-944b-e07fc1f90ae7/done",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ sent: 3, failed: 1 }),
                }),
            );
        });

        it("POSTs причину на /recruiting/broadcasts/:publicId/failed", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: "b-1", status: "FAILED" }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await new AwsBusinessClient().ackRecruitingBroadcastFailed("7c9e6679-7425-40de-944b-e07fc1f90ae7", "BROADCAST_TOO_LARGE");

            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/broadcasts/7c9e6679-7425-40de-944b-e07fc1f90ae7/failed",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ error: "BROADCAST_TOO_LARGE" }),
                }),
            );
        });
    });
});
