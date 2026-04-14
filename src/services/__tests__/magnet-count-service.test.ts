import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_VISION_MODEL: "gpt-4.1-mini",
    BOT_TOKEN: "bot-token",
}));

vi.mock("canvas", () => {
    const ctx = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({
            data: new Uint8ClampedArray(4 * 10),
        })),
        putImageData: vi.fn(),
    };

    const createCanvas = vi.fn((width: number, height: number) => ({
        width,
        height,
        getContext: vi.fn(() => ctx),
        toBuffer: vi.fn(() => Buffer.from([1, 2, 3])),
    }));

    const loadImage = vi.fn(async () => ({
        width: 1000,
        height: 800,
    }));

    return { createCanvas, loadImage };
});

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
        expect(result.confidence).toBe("low");
        expect(result.needsManualReview).toBe(true);
    });

    it("uses stack totals as the final total when per-stack data exists", async () => {
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
                        total: 999,
                        confidence: "medium",
                        stacks: [
                            { index: 1, estimatedCount: 10, confidence: "medium" },
                            { index: 2, estimatedCount: 11, confidence: "medium" },
                            { index: 3, estimatedCount: 10, confidence: "medium" },
                        ],
                        notes: "Three stacks visible.",
                        needsManualReview: false,
                    }),
                }),
            });

        vi.stubGlobal("fetch", fetchMock);

        const { MagnetCountService } = await import("../magnet-count-service.js");
        const service = new MagnetCountService();
        const result = await service.countFromTelegramPhoto("file-id");

        expect(result.total).toBe(31);
        expect(result.confidence).toBe("medium");
    });
});
