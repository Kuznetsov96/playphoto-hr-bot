import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    AWS_BUSINESS_API_URL: "https://api.example.test/api/v1/internal/bot/",
    AWS_BUSINESS_API_TOKEN: "a".repeat(32),
}));

/**
 * Канонические слоты интервью (фаза 2b): список, бронь и освобождение живут
 * в вебаппе. Схемы ответов НЕ `.strict()` — новое поле в ответе API уже
 * роняло сохранение побажань, здесь та же ловушка невозможна by construction.
 */
describe("AwsBusinessClient canonical interview slots", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const slot = {
        publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        startsAt: "2026-09-01T10:00:00.000Z",
        endsAt: "2026-09-01T10:15:00.000Z",
    };

    describe("listRecruitingInterviewSlots", () => {
        it("GETs /recruiting/interview-slots and parses the items", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ items: [slot] }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient().listRecruitingInterviewSlots();

            expect(result).toEqual({ items: [slot] });
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/interview-slots",
                expect.objectContaining({
                    method: "GET",
                    headers: expect.objectContaining({
                        authorization: `Bearer ${"a".repeat(32)}`,
                    }),
                }),
            );
        });

        it("tolerates extra fields in a slot — the schema must not be strict", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ items: [{ ...slot, addedLater: "x" }], total: 1 }),
                { status: 200 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().listRecruitingInterviewSlots())
                .resolves.toEqual({ items: [expect.objectContaining(slot)] });
        });
    });

    describe("bookRecruitingInterviewSlot", () => {
        it("POSTs the telegramId to /recruiting/interview-slots/:publicId/book and parses the slot", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify(slot),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient()
                .bookRecruitingInterviewSlot(slot.publicId, "1164289764");

            expect(result).toEqual(slot);
            expect(fetch).toHaveBeenCalledWith(
                `https://api.example.test/api/v1/internal/bot/recruiting/interview-slots/${slot.publicId}/book`,
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ telegramId: "1164289764" }),
                }),
            );
        });

        it("surfaces the RECRUITING_SLOT_TAKEN code from a 409 for the booking flow to catch", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ code: "RECRUITING_SLOT_TAKEN" }),
                { status: 409 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().bookRecruitingInterviewSlot(slot.publicId, "1164289764"))
                .rejects.toMatchObject({ status: 409, code: "RECRUITING_SLOT_TAKEN" });
        });

        it("surfaces RECRUITING_CANDIDATE_NOT_FOUND from a 404", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ code: "RECRUITING_CANDIDATE_NOT_FOUND" }),
                { status: 404 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().bookRecruitingInterviewSlot(slot.publicId, "1164289764"))
                .rejects.toMatchObject({ status: 404, code: "RECRUITING_CANDIDATE_NOT_FOUND" });
        });
    });

    describe("releaseRecruitingInterviewSlot", () => {
        it("POSTs the telegramId and the mandatory reason to /recruiting/interview-slots/release", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ released: true }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            const result = await new AwsBusinessClient()
                .releaseRecruitingInterviewSlot("1164289764", "candidate_cancelled");

            expect(result).toEqual({ released: true });
            expect(fetch).toHaveBeenCalledWith(
                "https://api.example.test/api/v1/internal/bot/recruiting/interview-slots/release",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ telegramId: "1164289764", reason: "candidate_cancelled" }),
                }),
            );
        });

        it("passes released:false through — no booked slot is not an error", async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(
                JSON.stringify({ released: false }),
                { status: 201 },
            ));
            const { AwsBusinessClient } = await import("../aws-business-client.js");

            await expect(new AwsBusinessClient().releaseRecruitingInterviewSlot("1164289764", "candidate_withdrew"))
                .resolves.toEqual({ released: false });
        });
    });
});
