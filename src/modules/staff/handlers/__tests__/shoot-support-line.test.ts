import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../config.js", () => ({ TEAM_CHATS: { SUPPORT: 999 } }));

const { forwardShootLineToTopic, takeShootSupportLine, withShootSupportPrefix } = await import("../shoot-support-line.js");

describe("shoot support line", () => {
    it("is taken once", () => {
        const session: { shootSupportLine?: string } = { shootSupportLine: "Зйомка · Олена" };
        expect(takeShootSupportLine(session)).toBe("Зйомка · Олена");
        expect(takeShootSupportLine(session)).toBeNull();
        expect("shootSupportLine" in session).toBe(false);
    });

    it("treats a blank line as none", () => {
        const session: { shootSupportLine?: string } = { shootSupportLine: "   " };
        expect(takeShootSupportLine(session)).toBeNull();
        expect("shootSupportLine" in session).toBe(false);
    });

    it("prefixes a new ticket with the escaped line", () => {
        expect(withShootSupportPrefix("Можна до п’ятниці?", "Зйомка · <Олена>")).toBe(
            "❓ <b>Питання по зйомці:</b>\nЗйомка · &lt;Олена&gt;\n\n<b>Питання:</b> Можна до п’ятниці?",
        );
    });

    it("posts the line into the open support topic", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
        expect(await forwardShootLineToTopic(api as never, 55, "Зйомка · Олена")).toBe(true);
        expect(api.sendMessage).toHaveBeenCalledWith(
            999,
            "❓ Звернення з нагадування про зйомку: Зйомка · Олена",
            { message_thread_id: 55, parse_mode: "HTML" },
        );
    });

    it("escapes the line posted into the open topic", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
        await forwardShootLineToTopic(api as never, 55, "Зйомка · <Олена>");
        expect(api.sendMessage.mock.calls[0]![1]).toBe("❓ Звернення з нагадування про зйомку: Зйомка · &lt;Олена&gt;");
    });

    it("does nothing without a topic", async () => {
        const api = { sendMessage: vi.fn() };
        expect(await forwardShootLineToTopic(api as never, null, "Зйомка")).toBe(false);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});
