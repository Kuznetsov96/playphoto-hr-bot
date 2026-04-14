import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_VISION_MODEL: "gpt-4.1-mini",
    BOT_TOKEN: "bot-token",
}));

describe("MagnetCountService", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it("downloads telegram photo and parses structured vision result", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: { file_path: "photos/test.jpg" } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    output_text: JSON.stringify({
                        total: 53,
                        confidence: "high",
                        stacks: [
                            { index: 1, estimatedCount: 20, confidence: "high" },
                            { index: 2, estimatedCount: 20, confidence: "high" },
                            { index: 3, estimatedCount: 13, confidence: "medium" },
                        ],
                        notes: "Three visible stacks.",
                        needsManualReview: false,
                    }),
                }),
            });

        vi.stubGlobal("fetch", fetchMock);

        const { MagnetCountService } = await import("../magnet-count-service.js");
        const service = new MagnetCountService();
        const result = await service.countFromTelegramPhoto("file-id");

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(result.total).toBe(53);
        expect(result.stacks).toHaveLength(3);
        expect(result.confidence).toBe("high");
    });
});
