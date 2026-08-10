import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://example.test/api/v1/internal/bot",
    AWS_BUSINESS_API_TOKEN: "x".repeat(32),
}));

const { awsBusinessClient } = await import("../aws-business-client.js");

const previewBody = {
    scheduledShiftPublicId: "11111111-1111-4111-8111-111111111111",
    requesterEmployeePublicId: "22222222-2222-4222-8222-222222222222",
    locationPublicId: "33333333-3333-4333-8333-333333333333",
    shiftStartsAt: "2026-08-15T08:00:00.000Z",
    shiftEndsAt: "2026-08-15T17:00:00.000Z",
    waves: [
        {
            wave: "SAME_LOCATION_AVAILABLE",
            candidates: [
                {
                    employeePublicId: "44444444-4444-4444-8444-444444444444",
                    displayName: "Олена К.",
                    availabilityKind: "AVAILABLE",
                },
            ],
        },
    ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("awsBusinessClient replacements", () => {
    it("posts the preview request and parses the canonical wave contract", async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => previewBody });

        const result = await awsBusinessClient.previewReplacement({
            scheduledShiftPublicId: previewBody.scheduledShiftPublicId,
            requesterEmployeePublicId: previewBody.requesterEmployeePublicId,
            requesterTelegramId: "12345",
        });

        expect(result.waves[0]!.candidates[0]!.employeePublicId).toBe(
            "44444444-4444-4444-8444-444444444444",
        );
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://example.test/api/v1/internal/bot/replacements/preview");
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            scheduledShiftPublicId: previewBody.scheduledShiftPublicId,
            requesterEmployeePublicId: previewBody.requesterEmployeePublicId,
            requesterTelegramId: "12345",
        });
    });

    it("rejects a preview payload that does not match the contract", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...previewBody, waves: [{ wave: "X" }] }),
        });
        await expect(
            awsBusinessClient.previewReplacement({
                scheduledShiftPublicId: previewBody.scheduledShiftPublicId,
                requesterEmployeePublicId: previewBody.requesterEmployeePublicId,
                requesterTelegramId: "12345",
            }),
        ).rejects.toThrow();
    });

    it("accepts an offer through the canonical endpoint", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                publicId: "55555555-5555-4555-8555-555555555555",
                status: "PENDING_APPROVAL",
            }),
        });

        const result = await awsBusinessClient.acceptReplacementOffer(
            "66666666-6666-4666-8666-666666666666",
            { employeePublicId: "44444444-4444-4444-8444-444444444444", telegramId: "12345" },
        );

        expect(result.status).toBe("PENDING_APPROVAL");
        expect(fetchMock.mock.calls[0]![0]).toBe(
            "https://example.test/api/v1/internal/bot/replacements/offers/66666666-6666-4666-8666-666666666666/accept",
        );
    });

    it("surfaces a non-2xx response as an error", async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
        await expect(
            awsBusinessClient.dispatchReplacementWave("55555555-5555-4555-8555-555555555555"),
        ).rejects.toThrow(/409/u);
    });
});
