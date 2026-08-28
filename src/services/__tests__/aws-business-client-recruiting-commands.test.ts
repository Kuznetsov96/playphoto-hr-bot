import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

/**
 * Команды рекрутёра (фаза 3a): вебапп кладёт решение рекрутёра в outbox, бот
 * забирает pending и отвечает applied/failed. Схемы НЕ `.strict()`, а `kind` —
 * произвольная строка, не enum: новый вид команды в более свежем вебаппе не
 * должен ронять разбор ВСЕЙ очереди — неизвестный kind диспетчер отбивает
 * поштучно громким failed.
 */
describe("AwsBusinessClient recruiter commands", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const command = {
        publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        kind: "INVITE_TO_INTERVIEW",
        reasonCode: null,
        reasonText: null,
        attempts: 0,
        candidate: {
            telegramId: "1164289764",
            botCandidateId: "cand-1",
            publicId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        },
    };

    describe("listPendingRecruitingCommands", () => {
        it("GETs /recruiting/commands/pending with the limit and parses the items", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ items: [command] }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().listPendingRecruitingCommands(20);

            expect(result).toEqual({ items: [command] });
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/commands/pending?limit=20",
                expect.objectContaining({
                    method: "GET",
                    headers: expect.objectContaining({
                        authorization: `Bearer ${"a".repeat(32)}`,
                    }),
                }),
            );
        });

        it("tolerates an unknown kind — the schema must carry it through as a plain string", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ items: [{ ...command, kind: "PROMOTE_TO_MENTOR" }] }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().listPendingRecruitingCommands(20))
                .resolves.toEqual({ items: [expect.objectContaining({ kind: "PROMOTE_TO_MENTOR" })] });
        });

        it("tolerates extra fields in a command — the schema must not be strict", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({
                    items: [{ ...command, addedLater: "x", candidate: { ...command.candidate, extra: 1 } }],
                    total: 1,
                }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().listPendingRecruitingCommands(20))
                .resolves.toEqual({ items: [expect.objectContaining({ publicId: command.publicId })] });
        });
    });

    describe("ackRecruitingCommandApplied", () => {
        it("POSTs to /recruiting/commands/:publicId/applied and parses the ack", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: command.publicId, status: "APPLIED" }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().ackRecruitingCommandApplied(command.publicId);

            expect(result).toEqual({ publicId: command.publicId, status: "APPLIED" });
            expect(fetch).toHaveBeenCalledWith(
                `https://api.example.test/api/v1/internal/bot/recruiting/commands/${command.publicId}/applied`,
                expect.objectContaining({ method: "POST" }),
            );
        });
    });

    describe("ackRecruitingCommandFailed", () => {
        it("POSTs the error text to /recruiting/commands/:publicId/failed", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: command.publicId, status: "PENDING", attempts: 1 }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient()
                .ackRecruitingCommandFailed(command.publicId, "CANDIDATE_NOT_FOUND_IN_BOT");

            expect(result).toEqual(expect.objectContaining({ publicId: command.publicId, status: "PENDING" }));
            expect(fetch).toHaveBeenCalledWith(
                `https://api.example.test/api/v1/internal/bot/recruiting/commands/${command.publicId}/failed`,
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ error: "CANDIDATE_NOT_FOUND_IN_BOT" }),
                }),
            );
        });

        it("truncates the error to the contract's 500 characters", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ publicId: command.publicId, status: "PENDING", attempts: 2 }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await new AwsBusinessClient().ackRecruitingCommandFailed(command.publicId, "x".repeat(600));

            const [, init] = vi.mocked(fetch).mock.calls[0]!;
            const body = JSON.parse((init as RequestInit).body as string) as { error: string };
            expect(body.error).toHaveLength(500);
        });
    });
});
