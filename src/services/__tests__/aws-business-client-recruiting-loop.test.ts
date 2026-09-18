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
});
