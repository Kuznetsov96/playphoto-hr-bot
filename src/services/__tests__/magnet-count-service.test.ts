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

    it("clamps a single inflated stack when the other main stacks align", async () => {
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
                        total: 42,
                        confidence: "medium",
                        stacks: [
                            { index: 1, estimatedCount: 12, confidence: "medium" },
                            { index: 2, estimatedCount: 17, confidence: "medium" },
                            { index: 3, estimatedCount: 12, confidence: "medium" },
                            { index: 4, estimatedCount: 1, confidence: "medium" },
                        ],
                        notes: "The stacks are transparent and somewhat ambiguous.",
                        needsManualReview: false,
                    }),
                }),
            });

        vi.stubGlobal("fetch", fetchMock);

        const { MagnetCountService } = await import("../magnet-count-service.js");
        const service = new MagnetCountService();
        const result = await service.countFromTelegramPhoto("file-id");

        expect(result.stacks.map((stack) => stack.estimatedCount)).toEqual([12, 12, 12, 1]);
        expect(result.total).toBe(37);
        expect(result.confidence).toBe("low");
        expect(result.needsManualReview).toBe(true);
        expect(result.notes).toContain("Adjusted an outlier stack");
    });

    it("uses an image-derived major stack heuristic to reduce seam overcounting", async () => {
        const { normalizeMagnetCountResult } = await import("../magnet-count-service.js");

        const result = normalizeMagnetCountResult({
            total: 37,
            confidence: "medium",
            stacks: [
                { index: 1, estimatedCount: 12, confidence: "medium" },
                { index: 2, estimatedCount: 12, confidence: "medium" },
                { index: 3, estimatedCount: 12, confidence: "medium" },
                { index: 4, estimatedCount: 1, confidence: "medium" },
            ],
            notes: "Transparent stacks with visible seams.",
            needsManualReview: false,
        }, {
            majorStackCount: 10,
            notes: ["Image heuristic estimated the major stack height at about 10 magnets."],
        });

        expect(result.stacks.map((stack) => stack.estimatedCount)).toEqual([10, 10, 10, 1]);
        expect(result.total).toBe(31);
        expect(result.confidence).toBe("low");
        expect(result.needsManualReview).toBe(true);
        expect(result.notes).toContain("Applied the image-derived major-stack height heuristic");
    });
});
