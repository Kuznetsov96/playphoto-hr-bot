import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

/**
 * Пуш снимка кандидата в зеркало вебаппа. Схема ответа НЕ `.strict()`:
 * новое поле в ответе API уже роняло сохранение побажань — здесь та же
 * ловушка невозможна by construction.
 */
describe("AwsBusinessClient.pushRecruitingCandidate", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const snapshot = {
        telegramId: "1164289764",
        botCandidateId: "cand-1",
        telegramUsername: "olena_test",
        fullName: "Олена Тест",
        phone: null,
        gender: "female" as const,
        birthDate: "2001-05-15",
        city: "Київ",
        locationCode: null,
        source: "olx",
        botStatus: "SCREENING",
        hrDecision: null,
        lossStage: null,
        lossReason: null,
        interviewAt: null,
        statusChangedAt: null,
        lastActivityAt: "2026-08-21T09:30:00.000Z",
        botCreatedAt: "2026-08-01T08:00:00.000Z",
    };

    it("POSTs the snapshot to /recruiting/candidates with bearer auth and parses the ack", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(
            JSON.stringify({ publicId: "pub-1", stage: "SCREENING" }),
            { status: 201 },
        ));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const ack = await new AwsBusinessClient().pushRecruitingCandidate(snapshot);

        expect(ack).toEqual({ publicId: "pub-1", stage: "SCREENING" });
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/recruiting/candidates",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify(snapshot),
                headers: expect.objectContaining({
                    authorization: `Bearer ${"a".repeat(32)}`,
                    "x-request-id": expect.stringMatching(/^telegram-bot:/u),
                }),
            }),
        );
    });

    it("tolerates extra fields in the ack — the schema must not be strict", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(
            JSON.stringify({ publicId: "pub-1", stage: "SCREENING", addedLater: "x" }),
            { status: 201 },
        ));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().pushRecruitingCandidate(snapshot))
            .resolves.toEqual(expect.objectContaining({ publicId: "pub-1", stage: "SCREENING" }));
    });

    it("throws AwsBusinessApiError on a non-2xx response", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(
            JSON.stringify({ code: "VALIDATION_FAILED" }),
            { status: 400 },
        ));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().pushRecruitingCandidate(snapshot))
            .rejects.toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    });
});
