import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "x".repeat(32) }));
const redisSet = vi.fn();
const redisGet = vi.fn();
vi.mock("../../core/redis.js", () => ({
    redis: { set: (...a: unknown[]) => redisSet(...a), get: (...a: unknown[]) => redisGet(...a) },
}));
const { sendReviewCard, renderReviewCard, retryKeyboard, reviewKeyboard, rejectKeyboard } = await import("../training-review-card.js");

const payload = {
    reviewPublicId: "5b0c3f5e-9a51-4c2b-9b7a-0c1f3e8d2a11",
    fileId: "AwAC",
    attachmentKind: "VOICE" as const,
    candidateName: "Марія Коваль",
    locationName: "Drive City",
    scorePct: 86,
    attemptNo: 2,
    checklist: ["Greeting", "Photo", "Magnets", "Set", "Too expensive", "Upsell"],
    reminder: true,
};

const COMMAND_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
    redisSet.mockReset().mockResolvedValue("OK");
    redisGet.mockReset().mockResolvedValue(null);
});

describe("review card", () => {
    it("shows name, location, score, attempt and the checklist", () => {
        const text = renderReviewCard(payload);
        expect(text).toContain("Марія Коваль");
        expect(text).toContain("Drive City");
        expect(text).toContain("86%");
        expect(text).toContain("Attempt 2");
        expect(text).toContain("waiting over 24 h");
        expect(text).toContain("6. Upsell");
    });

    it("keeps every callback within 64 bytes", () => {
        const all = [
            ...reviewKeyboard(payload.reviewPublicId).inline_keyboard.flat(),
            ...retryKeyboard(payload.reviewPublicId, 0b111111, payload.checklist).inline_keyboard.flat(),
            ...rejectKeyboard(payload.reviewPublicId).inline_keyboard.flat(),
        ];
        for (const button of all) {
            if ("callback_data" in button) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
        }
    });

    it("marks toggled items in the retry keyboard", () => {
        const kb = retryKeyboard(payload.reviewPublicId, 0b000101, payload.checklist);
        const labels = kb.inline_keyboard.flat().map((b) => b.text);
        expect(labels).toContain("✗ 1. Greeting");
        expect(labels).toContain("2. Photo");
        expect(labels).toContain("✗ 3. Magnets");
    });

    it("writes Redis before sending; a Redis failure sends nothing", async () => {
        redisSet.mockRejectedValueOnce(new Error("redis down"));
        const api = { sendVoice: vi.fn(), sendVideoNote: vi.fn(), sendMessage: vi.fn() };
        await expect(sendReviewCard(api as never, 1, payload, COMMAND_ID)).rejects.toThrow("redis down");
        expect(api.sendVoice).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("uses sendVideoNote for a video note", async () => {
        redisSet.mockResolvedValue("OK");
        const api = { sendVoice: vi.fn(), sendVideoNote: vi.fn(), sendMessage: vi.fn() };
        await sendReviewCard(api as never, 1, { ...payload, attachmentKind: "VIDEO_NOTE" }, COMMAND_ID);
        expect(api.sendVideoNote).toHaveBeenCalledWith(1, "AwAC");
        expect(api.sendVoice).not.toHaveBeenCalled();
    });

    it("retry after a failed card text does not send the voice again", async () => {
        const marks = new Map<string, string>();
        redisSet.mockImplementation(async (key: string, value: string) => {
            marks.set(key, value);
            return "OK";
        });
        redisGet.mockImplementation(async (key: string) => marks.get(key) ?? null);
        const api = {
            sendVoice: vi.fn().mockResolvedValue({ message_id: 8 }),
            sendVideoNote: vi.fn(),
            sendMessage: vi.fn().mockRejectedValueOnce(new Error("ETIMEDOUT")).mockResolvedValue({ message_id: 9 }),
        };

        await expect(sendReviewCard(api as never, 1, payload, COMMAND_ID)).rejects.toThrow("ETIMEDOUT");
        await sendReviewCard(api as never, 1, payload, COMMAND_ID);

        expect(api.sendVoice).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("a reminder (another command for the same review) sends the voice again", async () => {
        const marks = new Map<string, string>();
        redisSet.mockImplementation(async (key: string, value: string) => {
            marks.set(key, value);
            return "OK";
        });
        redisGet.mockImplementation(async (key: string) => marks.get(key) ?? null);
        const api = { sendVoice: vi.fn(), sendVideoNote: vi.fn(), sendMessage: vi.fn() };

        await sendReviewCard(api as never, 1, payload, COMMAND_ID);
        await sendReviewCard(api as never, 1, payload, "7c9e6679-7425-40de-944b-e07fc1f90ae7");

        expect(api.sendVoice).toHaveBeenCalledTimes(2);
    });

    it("refuses more than 6 checklist items", () => {
        expect(() => retryKeyboard(payload.reviewPublicId, 0, [...payload.checklist, "x"])).toThrow(
            "TRAINING_CHECKLIST_TOO_LONG",
        );
    });

    it("renders a missing location and score as a dash", () => {
        const text = renderReviewCard({ ...payload, locationName: null, scorePct: null });
        expect(text).toContain("Location: —");
        expect(text).toContain("Test score: —");
        expect(text).not.toContain("null");
    });
});
