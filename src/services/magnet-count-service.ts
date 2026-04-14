import { z } from "zod";
import { OPENAI_API_KEY, OPENAI_VISION_MODEL, BOT_TOKEN } from "../config.js";

const MagnetCountSchema = z.object({
    total: z.number().int().nonnegative(),
    confidence: z.enum(["high", "medium", "low"]),
    stacks: z.array(z.object({
        index: z.number().int().positive(),
        estimatedCount: z.number().int().nonnegative(),
        confidence: z.enum(["high", "medium", "low"]),
    })).default([]),
    notes: z.string().default(""),
    needsManualReview: z.boolean().default(false),
});

export type MagnetCountResult = z.infer<typeof MagnetCountSchema>;

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

export class MagnetCountService {
    isConfigured() {
        return Boolean(OPENAI_API_KEY);
    }

    async countFromTelegramPhoto(fileId: string): Promise<MagnetCountResult> {
        if (!OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is not configured");
        }

        const imageBuffer = await downloadTelegramPhoto(fileId);
        const imageBase64 = imageBuffer.toString("base64");

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
                                text:
                                    "Count fridge magnets packed in visible stacks on the photo. " +
                                    "Return stack-by-stack counts, total count, and confidence. " +
                                    "If stacks are partially hidden, reflect lower confidence and set needsManualReview=true. " +
                                    "Do not invent hidden stacks. Count only what is visible and plausibly present in each stack."
                            },
                            {
                                type: "input_image",
                                image_url: `data:image/jpeg;base64,${imageBase64}`,
                                detail: "high",
                            }
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
        return MagnetCountSchema.parse(JSON.parse(text));
    }
}

export const magnetCountService = new MagnetCountService();
