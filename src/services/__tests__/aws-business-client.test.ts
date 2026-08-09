import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

describe("AwsBusinessClient", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("authenticates and validates a complete business snapshot", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-08-08T12:00:00.000Z",
            completeEmployeeSnapshot: true,
            completeLocationSnapshot: true,
            scheduleWindow: { from: "2026-08-01", to: "2026-08-31" },
            locations: [{
                publicId: "11111111-1111-4111-8111-111111111111",
                canonicalCode: "location-code",
                name: "Location",
                city: "Kyiv",
                address: null,
                timezone: "Europe/Kyiv",
            }],
            employees: [],
            shifts: [],
        }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const value = await new AwsBusinessClient().snapshot("2026-08-01", "2026-08-31");

        expect(value.completeEmployeeSnapshot).toBe(true);
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/business-snapshot?from=2026-08-01&to=2026-08-31",
            expect.objectContaining({
                method: "GET",
                headers: expect.objectContaining({
                    authorization: `Bearer ${"a".repeat(32)}`,
                }),
            }),
        );
    });

    it("rejects an incomplete or malformed response", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-08-08T12:00:00.000Z",
            completeEmployeeSnapshot: false,
            completeLocationSnapshot: true,
            scheduleWindow: { from: "2026-08-01", to: "2026-08-31" },
            locations: [],
            employees: [],
            shifts: [],
        }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().snapshot("2026-08-01", "2026-08-31")).rejects.toThrow();
    });

    it("requests and validates one employee's minimal canonical schedule", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-08-09T12:00:00.000Z",
            employeePublicId: "22222222-2222-4222-8222-222222222222",
            scheduleWindow: { from: "2026-08-09", to: "2026-08-31" },
            shifts: [{
                publicId: "33333333-3333-4333-8333-333333333333",
                locationPublicId: "11111111-1111-4111-8111-111111111111",
                localDate: "2026-08-10",
                startsAt: "2026-08-10T08:00:00.000Z",
                endsAt: "2026-08-10T17:00:00.000Z",
            }],
        }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const value = await new AwsBusinessClient().employeeSchedule(
            "22222222-2222-4222-8222-222222222222",
            "2026-08-09",
            "2026-08-31",
        );

        expect(value.shifts).toHaveLength(1);
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/employees/22222222-2222-4222-8222-222222222222/schedule?from=2026-08-09&to=2026-08-31",
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("does not include an upstream response body in an HTTP error", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response("sensitive upstream body", { status: 503 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().snapshot("2026-08-01", "2026-08-31"))
            .rejects.toThrow("AWS business API request failed with HTTP 503");
    });
});
