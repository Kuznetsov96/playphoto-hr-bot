import { createCanvas, loadImage } from "canvas";
import { z } from "zod";
import { OPENAI_API_KEY, OPENAI_VISION_MODEL, BOT_TOKEN } from "../config.js";

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
        "Cross-check the variants before deciding.",
        "If the variants disagree, if transparent plastic makes the count ambiguous, or if stacks blend into each other, set confidence='low' and needsManualReview=true.",
        "Use confidence='high' only when the count is unambiguous across all variants. Transparent plastic stacks should almost never be high confidence.",
        "Prefer conservative counts over inflated counts.",
        "Return stack-by-stack counts from left to right. Include small isolated single items only if they are clearly separate physical pieces.",
        "Sanity-check the total against the visible stack heights. If the estimate seems too large for the visible stack heights, reduce confidence and choose the more conservative count.",
    ].join(" ");
}

async function buildImageVariants(imageBuffer: Buffer): Promise<ImageVariant[]> {
    const image = await loadImage(imageBuffer);
    const width = image.width;
    const height = image.height;

    const originalCanvas = createCanvas(width, height);
    const originalCtx = originalCanvas.getContext("2d");
    originalCtx.drawImage(image, 0, 0, width, height);

    const cropX = Math.round(width * 0.08);
    const cropY = Math.round(height * 0.47);
    const cropWidth = Math.round(width * 0.78);
    const cropHeight = Math.round(height * 0.30);

    const croppedCanvas = createCanvas(cropWidth, cropHeight);
    const croppedCtx = croppedCanvas.getContext("2d");
    croppedCtx.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const enhancedCanvas = createCanvas(cropWidth, cropHeight);
    const enhancedCtx = enhancedCanvas.getContext("2d");
    enhancedCtx.drawImage(croppedCanvas, 0, 0);

    const imageData = enhancedCtx.getImageData(0, 0, cropWidth, cropHeight);
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

    return [
        { label: "Original full photo", buffer: originalCanvas.toBuffer("image/jpeg", { quality: 0.92 }) },
        { label: "Cropped magnet area", buffer: croppedCanvas.toBuffer("image/jpeg", { quality: 0.92 }) },
        { label: "Enhanced grayscale crop", buffer: enhancedCanvas.toBuffer("image/jpeg", { quality: 0.92 }) },
    ];
}

function normalizeResult(result: MagnetCountResult): MagnetCountResult {
    const stackTotal = result.stacks.reduce((sum, stack) => sum + stack.estimatedCount, 0);
    const total = stackTotal > 0 ? stackTotal : result.total;

    let confidence = result.confidence;
    let needsManualReview = result.needsManualReview;
    const notes: string[] = [];

    if (result.notes) notes.push(result.notes);

    if (result.stacks.some((stack) => stack.confidence === "low")) {
        confidence = "low";
        needsManualReview = true;
        notes.push("At least one stack was low confidence.");
    }

    if (result.stacks.length >= 3 && total >= 45) {
        confidence = "low";
        needsManualReview = true;
        notes.push("Total looks inflated for the visible stack heights.");
    }

    if (result.stacks.length === 0) {
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
        total,
        confidence,
        needsManualReview,
        notes: notes.join(" ").trim(),
    };
}

export class MagnetCountService {
    isConfigured() {
        return Boolean(OPENAI_API_KEY);
    }

    async countFromTelegramPhoto(fileId: string): Promise<MagnetCountResult> {
        if (!OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is not configured");
        }

        const imageBuffer = await downloadTelegramPhoto(fileId);
        const variants = await buildImageVariants(imageBuffer);

        const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
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
                                detail: "high" as const,
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

        const payload = await response.json() as any;
        const text = extractResponseText(payload);
        const parsed = MagnetCountSchema.parse(JSON.parse(text));
        return normalizeResult(parsed);
    }
}

export const magnetCountService = new MagnetCountService();
