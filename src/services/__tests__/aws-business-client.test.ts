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
                branch: "Shevchyk",
                city: "Kyiv",
                address: null,
                timezone: "Europe/Kyiv",
                openingHours: [{ dayOfWeek: 1, opens: "14:00", closes: "21:00" }],
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

    /**
     * Deploy ordering: the bot may ship before the backend that sends the new fields. An older
     * API omits `branch` and `openingHours`, and rejecting that snapshot would stop schedule
     * syncing entirely. Missing must degrade to "nothing known yet", never to a hard failure.
     */
    it("accepts a snapshot from an API that predates branch and opening hours", async () => {
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

        expect(value.locations[0]).toEqual(expect.objectContaining({
            canonicalCode: "location-code",
            branch: null,
            openingHours: [],
        }));
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
        const timeout = vi.spyOn(AbortSignal, "timeout");
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
            { timeoutMs: 3_000 },
        );

        expect(value.shifts).toHaveLength(1);
        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/employees/22222222-2222-4222-8222-222222222222/schedule?from=2026-08-09&to=2026-08-31",
            expect.objectContaining({ method: "GET" }),
        );
        expect(timeout).toHaveBeenCalledWith(3_000);
    });

    it("does not include an upstream response body in an HTTP error", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response("sensitive upstream body", { status: 503 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        await expect(new AwsBusinessClient().snapshot("2026-08-01", "2026-08-31"))
            .rejects.toThrow("AWS business API request failed with HTTP 503");
    });

    describe("pendingScheduleNotifications", () => {
        const validNotification = {
            publicId: "n-good",
            employeePublicId: "e-1",
            telegramId: "100",
            changeKind: "SHIFT_MOVED",
            urgency: "URGENT",
            batchId: null,
            payload: {
                after: {
                    startsAtLocal: "2026-08-11T12:00:00",
                    endsAtLocal: "2026-08-11T20:00:00",
                    timezone: "Europe/Kyiv",
                    locationPublicId: "11111111-1111-4111-8111-111111111111",
                    locationName: "Location",
                    locationCity: "Kyiv",
                },
            },
        };

        it("keeps the valid rows and separates a malformed one instead of throwing", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
                items: [
                    validNotification,
                    // Payload fails the strict snapshot schema. Parsing the array as
                    // a whole made this throw and lose the valid row alongside it.
                    { ...validNotification, publicId: "n-bad", payload: { after: { startsAtLocal: 42 } } },
                ],
            }), { status: 200 }));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().pendingScheduleNotifications(100);

            expect(result.items.map(item => item.publicId)).toEqual(["n-good"]);
            expect(result.invalidPublicIds).toEqual(["n-bad"]);
            expect(result.unidentifiableCount).toBe(0);
        });

        it("counts a malformed row that has no usable publicId to report", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
                items: [validNotification, { nothing: "useful" }],
            }), { status: 200 }));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().pendingScheduleNotifications(100);

            expect(result.items.map(item => item.publicId)).toEqual(["n-good"]);
            expect(result.invalidPublicIds).toEqual([]);
            expect(result.unidentifiableCount).toBe(1);
        });

        it("still rejects a response whose envelope is not the agreed shape", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            // Per-row tolerance must not become tolerance for a wholly wrong response.
            await expect(new AwsBusinessClient().pendingScheduleNotifications(100)).rejects.toThrow();
        });
    });

    it("posts recognised telegram links to the backend", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ updated: 1 }), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");

        const result = await new AwsBusinessClient().reportTelegramLinks([
            { telegramId: "486213975", found: true, username: "ivan_petrov" },
        ]);

        expect(fetch).toHaveBeenCalledWith(
            "https://api.example.test/api/v1/internal/bot/telegram-links",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({
                    authorization: `Bearer ${"a".repeat(32)}`,
                }),
            }),
        );
        const call = vi.mocked(fetch).mock.calls.at(0);
        const requestInit = call?.[1];
        expect(JSON.parse(requestInit?.body as string)).toEqual({
            links: [{ telegramId: "486213975", found: true, username: "ivan_petrov" }],
        });
        expect(result).toEqual({ updated: 1 });
    });

    describe("missingSchedulePreferences", () => {
        // Mirrors the backend's real `listMissingForBot` response shape
        // (Webapp PlayPhoto/apps/api/src/schedule-preferences/schedule-preferences.service.ts):
        // `{ month, items: [{ employeePublicId, telegramId }] }`. The bot's schema
        // previously expected `employees`/`publicId`, which the real backend never
        // sends — every call threw under `.strict()`. This test exercises the real
        // schema against a stubbed fetch, not a mocked awsBusinessClient, so a future
        // contract drift is caught here rather than only in a mock that always agrees
        // with itself.
        const backendShapeBody = {
            month: "2026-09",
            items: [
                {
                    employeePublicId: "44444444-4444-4444-8444-444444444444",
                    telegramId: "123456789",
                },
            ],
        };

        it("parses the backend's real response shape", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(backendShapeBody), { status: 200 }));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().missingSchedulePreferences("2026-09");

            expect(result.month).toBe("2026-09");
            expect(result.items).toEqual([
                { employeePublicId: "44444444-4444-4444-8444-444444444444", telegramId: "123456789" },
            ]);
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/schedule-preferences/missing?month=2026-09",
                expect.objectContaining({ method: "GET" }),
            );
        });

        it("rejects the old, wrong shape (employees/publicId) the bot used to expect", async () => {
            const oldWrongShapeBody = {
                month: "2026-09",
                employees: [
                    {
                        publicId: "44444444-4444-4444-8444-444444444444",
                        telegramId: "123456789",
                    },
                ],
            };
            vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(oldWrongShapeBody), { status: 200 }));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().missingSchedulePreferences("2026-09")).rejects.toThrow();
        });
    });
});

/**
 * `schedulePreferenceReadSchema` is `.strict()` and this request sits inside
 * `saveCanonicalPreference` (it reads the version before writing), so a field the schema does
 * not declare does not degrade — it breaks saving preferences outright.
 *
 * That is exactly what happened when the backend started sending `worksUntil`: the bot rejected
 * every response and photographers got "не вдалося зберегти" on every submission.
 */
describe("AwsBusinessClient.getSchedulePreference", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function read(body: unknown) {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
        const { AwsBusinessClient } = await import("../aws-business-client.js");
        return new AwsBusinessClient().getSchedulePreference(
            "11111111-1111-4111-8111-111111111111",
            "2026-09",
            "123456789",
        );
    }

    it("accepts an absent submission carrying the backend's last-working-day field", async () => {
        await expect(read({ exists: false, worksUntil: null })).resolves.toEqual({
            exists: false,
            worksUntil: null,
        });
    });

    it("accepts an existing submission carrying the same field", async () => {
        await expect(
            read({
                exists: true,
                worksUntil: "2026-09-15",
                version: 3,
                status: "SUBMITTED",
                days: [{ localDate: "2026-09-05", kind: "UNAVAILABLE" }],
            }),
        ).resolves.toMatchObject({ exists: true, version: 3 });
    });

    it("accepts the collection-window field the menu gate reads", async () => {
        await expect(read({ exists: false, worksUntil: null, collectionOpen: false })).resolves.toMatchObject({
            collectionOpen: false,
        });
    });

    /** `.strict()` is kept on purpose: it still catches a misspelled field name. */
    it("still rejects a field nobody declared", async () => {
        await expect(read({ exists: false, worksUntill: null })).rejects.toThrow();
    });
});
