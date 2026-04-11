import { describe, expect, it } from "vitest";
import { buildSignedCallback, readCallbackPayload, readSignedCallback } from "../signed-callback.js";

describe("signed callback integrity", () => {
    it("accepts a valid signed callback", () => {
        const callback = buildSignedCallback("cnda", "candidate-123");

        expect(readSignedCallback(callback, "cnda")).toBe("candidate-123");
    });

    it("rejects a tampered payload", () => {
        const callback = buildSignedCallback("cnda", "candidate-123");
        const tampered = callback.replace("candidate-123", "candidate-999");

        expect(readSignedCallback(tampered, "cnda")).toBeNull();
    });

    it("falls back to legacy payloads during migration", () => {
        expect(readCallbackPayload("confirm_nda_candidate-123", {
            code: "cnda",
            legacyPrefix: "confirm_nda_"
        })).toBe("candidate-123");
    });
});
