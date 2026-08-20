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

    it("undoes an acceptance through the canonical endpoint", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                publicId: "55555555-5555-4555-8555-555555555555",
                status: "ACTIVE",
            }),
        });

        const result = await awsBusinessClient.undoReplacementAcceptance(
            "66666666-6666-4666-8666-666666666666",
            "44444444-4444-4444-8444-444444444444",
            "12345",
        );

        expect(result.status).toBe("ACTIVE");
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(
            "https://example.test/api/v1/internal/bot/replacements/offers/66666666-6666-4666-8666-666666666666/undo",
        );
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            employeePublicId: "44444444-4444-4444-8444-444444444444",
            telegramId: "12345",
        });
    });

    it("reverts an auto-confirmed replacement without sending a telegram id", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                publicId: "55555555-5555-4555-8555-555555555555",
                status: "ACTIVE",
            }),
        });

        const result = await awsBusinessClient.revertReplacementAsOwner(
            "55555555-5555-4555-8555-555555555555",
            true,
        );

        expect(result.status).toBe("ACTIVE");
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(
            "https://example.test/api/v1/internal/bot/replacements/55555555-5555-4555-8555-555555555555/revert",
        );
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            acknowledgeLateRevert: true,
        });
    });

    it("fetches pending replacement notifications and separates malformed rows", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [
                    {
                        publicId: "n-1",
                        kind: "OFFER_CLOSED",
                        telegramId: "222",
                        payload: {
                            startsAtLocal: "2026-08-15T10:00",
                            endsAtLocal: "2026-08-15T19:00",
                            timezone: "Europe/Kyiv",
                            locationPublicId: "loc-1",
                            locationName: "Аркадія",
                            locationCity: "Одеса",
                            replacementPublicId: "req-1",
                        },
                    },
                    { publicId: "n-2", kind: "NOT_A_REAL_KIND" },
                    { notPublicIdAtAll: true },
                ],
            }),
        });

        const result = await awsBusinessClient.pendingReplacementNotifications(50);

        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.publicId).toBe("n-1");
        expect(result.invalidPublicIds).toEqual(["n-2"]);
        expect(result.unidentifiableCount).toBe(1);
        expect(fetchMock.mock.calls[0]![0]).toBe(
            "https://example.test/api/v1/internal/bot/replacement-notifications/pending?limit=50",
        );
    });

    it("marks a replacement notification delivered", async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

        await awsBusinessClient.markReplacementNotificationDelivered("n-1");

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(
            "https://example.test/api/v1/internal/bot/replacement-notifications/n-1/delivered",
        );
        expect((init as RequestInit).method).toBe("POST");
    });

    it("marks a replacement notification failed with a truncated reason", async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

        await awsBusinessClient.markReplacementNotificationFailed("n-1", "x".repeat(600));

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://example.test/api/v1/internal/bot/replacement-notifications/n-1/failed");
        const body = JSON.parse((init as RequestInit).body as string) as { reason: string };
        expect(body.reason).toHaveLength(500);
    });
});

/**
 * Прод, 17–20.08: каждое нажатие «Не можу» падало с OFFER_ANSWER_FAILED, фотографы
 * жали повторно и получали то же самое. Причина не в бэкенде — он на отказ отвечает
 * `{ status: "DECLINED" }` и идемпотентен, — а в том, что клиент разбирал этот ответ
 * схемой полного запроса, требующей `publicId`. Разбор падал уже после успешного
 * HTTP 200, ошибка выходила без `code`, и бот показывал «Спробуй ще раз».
 */
describe("awsBusinessClient declineReplacementOffer", () => {
    const offerPublicId = "55555555-5555-4555-8555-555555555555";
    const input = {
        employeePublicId: "44444444-4444-4444-8444-444444444444",
        telegramId: "1368744350",
    };

    it("accepts the backend's decline acknowledgement as-is", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: "DECLINED" }),
        });

        await expect(
            awsBusinessClient.declineReplacementOffer(offerPublicId, input),
        ).resolves.toMatchObject({ status: "DECLINED" });
    });

    it("posts to the decline endpoint with the employee and telegram id", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: "DECLINED" }),
        });

        await awsBusinessClient.declineReplacementOffer(offerPublicId, input);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toContain(`/replacements/offers/${offerPublicId}/decline`);
        expect(JSON.parse(String(init.body))).toEqual(input);
    });

    /**
     * Повторное нажатие: бэкенд на уже отклонённом оффере возвращает тот же
     * `{ status: "DECLINED" }`, а не ошибку. Клиент обязан пройти так же, иначе
     * идемпотентность бэкенда не доходит до фотографа.
     */
    it("stays successful when the same offer is declined twice", async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: "DECLINED" }),
        });

        await awsBusinessClient.declineReplacementOffer(offerPublicId, input);

        await expect(
            awsBusinessClient.declineReplacementOffer(offerPublicId, input),
        ).resolves.toMatchObject({ status: "DECLINED" });
    });
});
