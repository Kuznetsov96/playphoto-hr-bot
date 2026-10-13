import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "x".repeat(32) }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn() } }));
const { renderReviewCard, retryKeyboard, reviewKeyboard, rejectKeyboard } = await import("../training-review-card.js");

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
});
