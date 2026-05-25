import { describe, expect, it, vi } from "vitest";
import { broadcastService } from "../broadcast.js";

describe("broadcastService media delivery", () => {
    it("sends animation broadcasts and follows up with formatted text/buttons", async () => {
        const api = {
            sendAnimation: vi.fn().mockResolvedValue({ message_id: 10 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
        };

        await broadcastService.sendTestBroadcast(
            api,
            123,
            "<b>Hello</b>",
            { type: "animation", fileId: "gif-file-id" },
            "default"
        );

        expect(api.sendAnimation).toHaveBeenCalledWith(123, "gif-file-id");
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "<b>Hello</b>",
            expect.objectContaining({ parse_mode: "HTML", reply_markup: expect.any(Object) })
        );
    });

    it("sends document broadcasts without buttons when requested", async () => {
        const api = {
            sendDocument: vi.fn().mockResolvedValue({ message_id: 10 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
        };

        await broadcastService.sendTestBroadcast(
            api,
            123,
            "Plain text",
            { type: "document", fileId: "document-file-id" },
            "none"
        );

        expect(api.sendDocument).toHaveBeenCalledWith(123, "document-file-id");
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "Plain text",
            expect.not.objectContaining({ reply_markup: expect.anything() })
        );
    });
});
