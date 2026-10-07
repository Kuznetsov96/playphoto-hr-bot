import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrammyError } from "grammy";

vi.mock("../../config/callback-secret.js", () => ({ CALLBACK_SECRET: "test-secret" }));
const { logOutgoing, findUnique } = vi.hoisted(() => ({
    logOutgoing: vi.fn(),
    findUnique: vi.fn(),
}));
vi.mock("../../repositories/chat-log-repository.js", () => ({ chatLogRepository: { logOutgoing } }));
vi.mock("../../db/core.js", () => ({ default: { user: { findUnique } } }));

const { chatLogTransformer } = await import("../chat-logger.js");
const { renderShootTask } = await import("../../services/shoot-task-render.js");

const assigned = renderShootTask({
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    ref: "abcdefgh2345",
    kind: "ASSIGNED",
    telegramId: "1164289764",
    shoot: {
        clientName: "Олена", childName: "Марійка", phone: "+380671231301", notes: null,
        location: { name: "Dragon Park 1", city: "Lviv", branch: null },
        shootOn: "2030-03-16", intervals: [{ start: "15:00", end: "16:00" }], durationMinutes: 60,
    },
    dueOn: "2030-03-19", canMoveDue: false, overdueDays: null, returnComment: null, pathB: false, targetMessageId: null,
});
const payload = { chat_id: 1164289764, text: assigned.text, parse_mode: "HTML" };

async function stored(): Promise<string> {
    await vi.waitFor(() => expect(logOutgoing).toHaveBeenCalled());
    return logOutgoing.mock.calls.map((call) => call.slice(1).map(String).join("|")).join("\n");
}

beforeEach(() => {
    logOutgoing.mockReset();
    findUnique.mockReset().mockResolvedValue({ id: "u1" });
});

describe("chatLogTransformer: телефон клієнта ASSIGNED", () => {
    it("успішна відправка — у ChatLog лише останні 4 цифри", async () => {
        const prev = vi.fn().mockResolvedValue({ message_id: 1 });
        await chatLogTransformer(prev as never, "sendMessage", payload as never);
        const text = await stored();
        expect(text).not.toContain("380671231301");
        expect(text).not.toMatch(/067123/u);
        expect(text).toContain("…1301");
    });

    it("відмова Telegram — так само", async () => {
        const error = new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", payload);
        const prev = vi.fn().mockRejectedValue(error);
        await expect(chatLogTransformer(prev as never, "sendMessage", payload as never)).rejects.toBe(error);
        const text = await stored();
        expect(text).not.toContain("380671231301");
        expect(text).not.toMatch(/067123/u);
        expect(text).toContain("…1301");
    });
});
