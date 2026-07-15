import { describe, expect, it, vi } from "vitest";
import type { MyContext } from "../../types/context.js";
import { richMessageInputMiddleware } from "../rich-message.js";

async function runMiddleware(message: Record<string, unknown>) {
    const next = vi.fn(async () => undefined);
    const ctx = { message } as unknown as MyContext;

    await richMessageInputMiddleware(ctx, next);

    return { message, next };
}

describe("richMessageInputMiddleware", () => {
    it("makes formatted rich text available to message:text handlers", async () => {
        const { message, next } = await runMiddleware({
            rich_message: {
                blocks: [{ type: "paragraph", text: ["Hello ", { type: "bold", text: "team" }] }],
            },
        });

        expect(message.text).toBe("Hello team");
        expect(next).toHaveBeenCalledOnce();
    });

    it("preserves native text when Telegram supplies it", async () => {
        const { message } = await runMiddleware({
            text: "Native text",
            rich_message: { blocks: [{ type: "paragraph", text: "Rich text" }] },
        });

        expect(message.text).toBe("Native text");
    });

    it("leaves pure rich media for media-aware handlers", async () => {
        const { message } = await runMiddleware({
            rich_message: { blocks: [{ type: "photo", photo: [] }] },
        });

        expect(message).not.toHaveProperty("text");
    });
});
