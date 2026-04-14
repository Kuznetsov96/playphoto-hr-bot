import { createCanvas, loadImage } from "canvas";
import { z } from "zod";
import { OPENAI_API_KEY, OPENAI_VISION_MODEL, BOT_TOKEN } from "../config.js";
import logger from "../core/logger.js";

const StackSchema = z.object({
    index: z.number().int().positive(),
    estimatedCount: z.number().int().nonnegative(),
    confidence: z.enum(["high", "medium", "low"]),
});

const MagnetCountSchema = z.object({
    total: z.number().int().nonnegative(),
    confidence: z.enum(["high", "medium", "low"]),
    stacks: z.array(StackSchema).default([]),
    notes: z.string().default(""),
    needsManualReview: z.boolean().default(false),
});

export type MagnetCountResult = z.infer<typeof MagnetCountSchema>;

type ImageVariant = {
    label: string;
    buffer: Buffer;
};

type MagnetImageHeuristic = {
    majorStackCount?: number;
    notes: string[];
};

type LoadedCanvasImage = Awaited<ReturnType<typeof loadImage>>;

type PreparedImageAnalysis = {
    variants: Array<ImageVariant & { detail: "low" | "high" }>;
    heuristic: MagnetImageHeuristic;
};

function extractResponseText(payload: any): string {
    if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
        return payload.output_text.trim();
    }

    const output = Array.isArray(payload?.output) ? payload.output : [];
    for (const item of output) {
        if (!Array.isArray(item?.content)) continue;
        for (const content of item.content) {
            if (typeof content?.text === "string" && content.text.trim()) {
                return content.text.trim();
            }
        }
    }

    throw new Error("Vision response did not contain text output");
}

async function downloadTelegramPhoto(fileId: string): Promise<Buffer> {
    if (!BOT_TOKEN) {
        throw new Error("BOT token is not configured");
    }

    const fileResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!fileResponse.ok) {
        throw new Error(`Telegram getFile failed with ${fileResponse.status}`);
    }

    const filePayload = await fileResponse.json() as any;
    const filePath = filePayload?.result?.file_path;
    if (!filePath) {
        throw new Error("Telegram file_path is missing");
    }

    const imageResponse = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!imageResponse.ok) {
        throw new Error(`Telegram file download failed with ${imageResponse.status}`);
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

function buildPrompt(variantLabels: string[]) {
    const labelText = variantLabels.map((label, index) => `${index + 1}. ${label}`).join("; ");

    return [
        "You are counting physical packaged fridge magnets stacked on a counter.",
        `You are given multiple versions of the same photo: ${labelText}.`,
        "The objects are transparent plastic magnet cases. Internal reflections, horizontal ribbing, and edges inside the plastic are NOT additional magnets.",
        "Count only physical items. Never count reflections, back-wall lines, or inner transparent contours as separate magnets.",
        "Do not count horizontal line segments. Transparent cases often show extra top and bottom edges, so the number of visible horizontal seams can be 1-2 higher than the number of physical magnets.",
        "Cross-check the variants before deciding.",
        "If the variants disagree, if transparent plastic makes the count ambiguous, or if stacks blend into each other, set confidence='low' and needsManualReview=true.",
        "Use confidence='high' only when the count is unambiguous across all variants. Transparent plastic stacks should almost never be high confidence.",
        "Prefer conservative counts over inflated counts.",
        "If several main stacks appear to be the same height, keep their counts the same or within 1 unless there is clear visual evidence that one stack is taller.",
        "Return stack-by-stack counts from left to right. Include small isolated single items only if they are clearly separate physical pieces.",
        "Sanity-check the total against the visible stack heights. If the estimate seems too large for the visible stack heights, reduce confidence and choose the more conservative count.",
    ].join(" ");
}

function getMagnetCropBounds(image: LoadedCanvasImage) {
    const width = image.width;
    const height = image.height;

    return {
        cropX: Math.round(width * 0.08),
        cropY: Math.round(height * 0.47),
        cropWidth: Math.round(width * 0.78),
        cropHeight: Math.round(height * 0.30),
    };
}

function buildMagnetCrop(image: LoadedCanvasImage) {
    const { cropX, cropY, cropWidth, cropHeight } = getMagnetCropBounds(image);
    const croppedCanvas = createCanvas(cropWidth, cropHeight);
    const croppedCtx = croppedCanvas.getContext("2d");
    croppedCtx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return { canvas: croppedCanvas, width: cropWidth, height: cropHeight };
}

function buildEnhancedCrop(croppedCanvas: ReturnType<typeof createCanvas>) {
    const enhancedCanvas = createCanvas(croppedCanvas.width, croppedCanvas.height);
    const enhancedCtx = enhancedCanvas.getContext("2d");
    enhancedCtx.drawImage(croppedCanvas, 0, 0);

    const imageData = enhancedCtx.getImageData(0, 0, croppedCanvas.width, croppedCanvas.height);
    const data = imageData.data;
    const contrast = 1.35;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        const gray = Math.round((r * 0.299) + (g * 0.587) + (b * 0.114));
        const contrasted = Math.max(0, Math.min(255, ((gray - 128) * contrast) + 128));
        data[i] = contrasted;
        data[i + 1] = contrasted;
        data[i + 2] = contrasted;
    }

    enhancedCtx.putImageData(imageData, 0, 0);
    return enhancedCanvas;
}

function toGrayscaleMatrix(buffer: Uint8ClampedArray, width: number, height: number) {
    const gray = new Array<number>(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const r = buffer[i] ?? 0;
            const g = buffer[i + 1] ?? 0;
            const b = buffer[i + 2] ?? 0;
            gray[(y * width) + x] = (r * 0.299) + (g * 0.587) + (b * 0.114);
        }
    }

    return gray;
}

function estimateLayerCountInWindow(
    gray: number[],
    width: number,
    height: number,
    startX: number,
    endX: number
) {
    const rowStart = Math.max(1, Math.floor(height * 0.28));
    const rowEnd = Math.min(height - 2, Math.floor(height * 0.87));
    const mergeGap = Math.max(10, Math.round(height * 0.035));
    const signal: number[] = [];
    let maxSignal = 0;

    for (let y = rowStart; y <= rowEnd; y += 1) {
        let sum = 0;
        for (let x = startX; x < endX; x += 1) {
            const below = gray[((y + 1) * width) + x] ?? 0;
            const above = gray[((y - 1) * width) + x] ?? 0;
            sum += Math.abs(below - above);
        }
        const avg = sum / Math.max(1, endX - startX);
        signal[y] = avg;
        if (avg > maxSignal) maxSignal = avg;
    }

    const threshold = Math.max(18, maxSignal * 0.28);
    const peaks: number[] = [];
    for (let y = rowStart + 1; y < rowEnd - 1; y += 1) {
        const value = signal[y] ?? 0;
        if (value < threshold) continue;
        if (value >= (signal[y - 1] ?? 0) && value > (signal[y + 1] ?? 0)) {
            peaks.push(y);
        }
    }

    const merged: number[] = [];
    for (const peak of peaks) {
        if (merged.length === 0 || peak - merged[merged.length - 1]! > mergeGap) {
            merged.push(peak);
        }
    }

    const filtered = merged.filter((peak) => peak >= Math.floor(height * 0.31));
    if (filtered.length < 5 || filtered.length > 13) {
        return undefined;
    }

    return filtered.length + 1;
}

function estimateMagnetImageHeuristic(image: LoadedCanvasImage): MagnetImageHeuristic {
    const crop = buildMagnetCrop(image);
    const ctx = crop.canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, crop.width, crop.height);
    const gray = toGrayscaleMatrix(imageData.data, crop.width, crop.height);
    const windows: Array<[number, number]> = [
        [0.04, 0.30],
        [0.34, 0.54],
        [0.58, 0.76],
    ];

    const candidateCounts = windows
        .map(([start, end]) => estimateLayerCountInWindow(
            gray,
            crop.width,
            crop.height,
            Math.round(crop.width * start),
            Math.round(crop.width * end),
        ))
        .filter((count): count is number => typeof count === "number");

    if (candidateCounts.length < 3) {
        return { notes: [] };
    }

    const sorted = [...candidateCounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const consistent = candidateCounts.every((count) => Math.abs(count - median) <= 1);

    if (!consistent || median < 6 || median > 14) {
        return { notes: [] };
    }

    return {
        majorStackCount: median,
        notes: [`Image heuristic estimated the major stack height at about ${median} magnets.`],
    };
}

async function prepareImageAnalysis(imageBuffer: Buffer): Promise<PreparedImageAnalysis> {
    const image = await loadImage(imageBuffer);
    const heuristic = estimateMagnetImageHeuristic(image);
    const crop = buildMagnetCrop(image);
    const variants: Array<ImageVariant & { detail: "low" | "high" }> = [
        { label: "Cropped magnet area", buffer: crop.canvas.toBuffer("image/jpeg", { quality: 0.9 }), detail: "low" },
    ];

    if (!heuristic.majorStackCount) {
        const enhancedCanvas = buildEnhancedCrop(crop.canvas);
        variants.push({
            label: "Enhanced grayscale crop",
            buffer: enhancedCanvas.toBuffer("image/jpeg", { quality: 0.88 }),
            detail: "low",
        });
    }

    return { variants, heuristic };
}

function applyMajorStackHeightHeuristic(
    stacks: MagnetCountResult["stacks"],
    heuristic?: MagnetImageHeuristic
) {
    if (!heuristic?.majorStackCount || stacks.length < 3) {
        return { stacks, applied: false };
    }

    const normalized = stacks.map((stack) => ({ ...stack }));
    const majorStacks = normalized.filter((stack) => stack.estimatedCount >= 3);
    if (majorStacks.length < 3) {
        return { stacks: normalized, applied: false };
    }

    const heuristicCount = heuristic.majorStackCount;
    const closeInflatedStacks = majorStacks.filter((stack) => (
        stack.estimatedCount >= heuristicCount + 1 && stack.estimatedCount <= heuristicCount + 3
    )).length;

    if (closeInflatedStacks < 2) {
        return { stacks: normalized, applied: false };
    }

    let applied = false;
    for (const stack of normalized) {
        if (stack.estimatedCount >= heuristicCount + 1) {
            stack.estimatedCount = heuristicCount;
            stack.confidence = "low";
            applied = true;
        }
    }

    return { stacks: normalized, applied };
}

export function normalizeMagnetCountResult(
    result: MagnetCountResult,
    heuristic?: MagnetImageHeuristic
): MagnetCountResult {
    const outlierAdjustedStacks = normalizeSimilarStackOutliers(result.stacks);
    const heuristicAdjusted = applyMajorStackHeightHeuristic(outlierAdjustedStacks, heuristic);
    const stacks = heuristicAdjusted.stacks;
    const stackTotal = stacks.reduce((sum, stack) => sum + stack.estimatedCount, 0);
    const total = stackTotal > 0 ? stackTotal : result.total;

    let confidence = result.confidence;
    let needsManualReview = result.needsManualReview;
    const notes: string[] = [];

    if (result.notes) notes.push(result.notes);
    if (heuristic?.notes.length) notes.push(...heuristic.notes);

    if (stacks.some((stack) => stack.confidence === "low")) {
        confidence = "low";
        needsManualReview = true;
        notes.push("At least one stack was low confidence.");
    }

    if (result.stacks.length !== stacks.length || result.stacks.some((stack, index) => stack.estimatedCount !== stacks[index]?.estimatedCount)) {
        confidence = "low";
        needsManualReview = true;
        notes.push("Adjusted an outlier stack to match the visible height pattern more conservatively.");
    }

    if (heuristicAdjusted.applied) {
        confidence = "low";
        needsManualReview = true;
        notes.push("Applied the image-derived major-stack height heuristic to reduce seam overcounting.");
    }

    if (stacks.length >= 3 && total >= 45) {
        confidence = "low";
        needsManualReview = true;
        notes.push("Total looks inflated for the visible stack heights.");
    }

    if (stacks.length === 0) {
        confidence = "low";
        needsManualReview = true;
        notes.push("No reliable per-stack breakdown was detected.");
    }

    if (confidence === "high") {
        confidence = "medium";
        needsManualReview = true;
        notes.push("Transparent plastic stacks require manual confirmation even when they look clear.");
    }

    return {
        ...result,
        stacks,
        total,
        confidence,
        needsManualReview,
        notes: notes.join(" ").trim(),
    };
}

function normalizeSimilarStackOutliers(stacks: MagnetCountResult["stacks"]): MagnetCountResult["stacks"] {
    if (stacks.length < 3) {
        return stacks;
    }

    const normalized = stacks.map((stack) => ({ ...stack }));
    const majorStacks = normalized.filter((stack) => stack.estimatedCount >= 3);

    if (majorStacks.length < 3) {
        return normalized;
    }

    const counts = majorStacks.map((stack) => stack.estimatedCount).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)] ?? 0;
    const alignedClusterSize = majorStacks.filter((stack) => Math.abs(stack.estimatedCount - median) <= 1).length;

    if (alignedClusterSize < 2) {
        return normalized;
    }

    for (const stack of normalized) {
        if (stack.estimatedCount >= median + 4) {
            stack.estimatedCount = median;
            stack.confidence = "low";
        }
    }

    return normalized;
}

export class MagnetCountService {
    isConfigured() {
        return Boolean(OPENAI_API_KEY);
    }

    async countFromTelegramPhoto(fileId: string): Promise<MagnetCountResult> {
        if (!OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is not configured");
        }

        const startedAt = Date.now();
        const downloadStartedAt = Date.now();
        const imageBuffer = await downloadTelegramPhoto(fileId);
        const downloadedAt = Date.now();
        const preprocessStartedAt = Date.now();
        const { variants, heuristic } = await prepareImageAnalysis(imageBuffer);
        const preprocessedAt = Date.now();
        const requestStartedAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);

        try {
            const response = await fetch("https://api.openai.com/v1/responses", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${OPENAI_API_KEY}`,
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: OPENAI_VISION_MODEL,
                    input: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: buildPrompt(variants.map((variant) => variant.label)),
                                },
                                ...variants.map((variant) => ({
                                    type: "input_image" as const,
                                    image_url: `data:image/jpeg;base64,${variant.buffer.toString("base64")}`,
                                    detail: variant.detail,
                                }))
                            ]
                        }
                    ],
                    text: {
                        format: {
                            type: "json_schema",
                            name: "magnet_count_result",
                            strict: true,
                            schema: {
                                type: "object",
                                additionalProperties: false,
                                properties: {
                                    total: { type: "integer", minimum: 0 },
                                    confidence: { type: "string", enum: ["high", "medium", "low"] },
                                    stacks: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            additionalProperties: false,
                                            properties: {
                                                index: { type: "integer", minimum: 1 },
                                                estimatedCount: { type: "integer", minimum: 0 },
                                                confidence: { type: "string", enum: ["high", "medium", "low"] },
                                            },
                                            required: ["index", "estimatedCount", "confidence"]
                                        }
                                    },
                                    notes: { type: "string" },
                                    needsManualReview: { type: "boolean" }
                                },
                                required: ["total", "confidence", "stacks", "notes", "needsManualReview"]
                            }
                        }
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new Error(`OpenAI vision request failed with ${response.status}: ${errorText}`);
            }

            const respondedAt = Date.now();
            const payload = await response.json() as any;
            const parsedStartedAt = Date.now();
            const text = extractResponseText(payload);
            const parsed = MagnetCountSchema.parse(JSON.parse(text));
            const normalized = normalizeMagnetCountResult(parsed, heuristic);
            const finishedAt = Date.now();

            logger.info({
                fileId,
                model: OPENAI_VISION_MODEL,
                variantCount: variants.length,
                variantDetails: variants.map((variant) => ({ label: variant.label, detail: variant.detail })),
                heuristicDetectedMajorStack: heuristic.majorStackCount ?? null,
                timingsMs: {
                    total: finishedAt - startedAt,
                    telegramDownload: downloadedAt - downloadStartedAt,
                    preprocess: preprocessedAt - preprocessStartedAt,
                    openaiRequest: respondedAt - requestStartedAt,
                    responseParse: finishedAt - parsedStartedAt,
                }
            }, "Magnet count analysis completed");

            return normalized;
        } catch (error) {
            if ((error as Error)?.name === "AbortError") {
                throw new Error("OpenAI vision request timed out after 20s");
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}

export const magnetCountService = new MagnetCountService();
