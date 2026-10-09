import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../config.js", () => ({ TEAM_CHATS: { SUPPORT: 999 } }));

const {
    SHOOT_SUPPORT_LINE_TTL_MS,
    clearShootSupportLine,
    forwardShootLineToTopic,
    putShootSupportLine,
    takeShootSupportLine,
    withShootSupportPrefix,
} = await import("../shoot-support-line.js");

const T0 = 1_900_000_000_000;

describe("shoot support line", () => {
    it("is taken once, with the time it was put", () => {
        const session: { shootSupportLine?: unknown } = {};
        putShootSupportLine(session, "Зйомка · Олена", T0);
        expect(takeShootSupportLine(session, T0 + 1000)).toEqual({ line: "Зйомка · Олена", at: T0 });
        expect(takeShootSupportLine(session, T0 + 1000)).toBeNull();
        expect("shootSupportLine" in session).toBe(false);
    });

    it("lives 30 minutes", () => {
        expect(SHOOT_SUPPORT_LINE_TTL_MS).toBe(30 * 60_000);
        const fresh: { shootSupportLine?: unknown } = {};
        putShootSupportLine(fresh, "Зйомка", T0);
        expect(takeShootSupportLine(fresh, T0 + 29 * 60_000)).toEqual({ line: "Зйомка", at: T0 });

        const stale: { shootSupportLine?: unknown } = {};
        putShootSupportLine(stale, "Зйомка", T0);
        expect(takeShootSupportLine(stale, T0 + 31 * 60_000)).toBeNull();
        expect("shootSupportLine" in stale).toBe(false);
    });

    it("drops a session value from before the TTL (plain string) as expired", () => {
        const session: { shootSupportLine?: unknown } = { shootSupportLine: "Зйомка · Олена" };
        expect(takeShootSupportLine(session, T0)).toBeNull();
        expect("shootSupportLine" in session).toBe(false);
    });

    it("treats a blank line as none", () => {
        const session: { shootSupportLine?: unknown } = {};
        putShootSupportLine(session, "   ", T0);
        expect(takeShootSupportLine(session, T0)).toBeNull();
        expect("shootSupportLine" in session).toBe(false);
    });

    it("is cleared explicitly", () => {
        const session: { shootSupportLine?: unknown } = {};
        putShootSupportLine(session, "Зйомка", T0);
        clearShootSupportLine(session);
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
            "❓ From a shoot reminder: Зйомка · Олена",
            { message_thread_id: 55, parse_mode: "HTML" },
        );
    });

    it("escapes the line posted into the open topic", async () => {
        const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
        await forwardShootLineToTopic(api as never, 55, "Зйомка · <Олена>");
        expect(api.sendMessage.mock.calls[0]![1]).toBe("❓ From a shoot reminder: Зйомка · &lt;Олена&gt;");
    });

    it("does nothing without a topic", async () => {
        const api = { sendMessage: vi.fn() };
        expect(await forwardShootLineToTopic(api as never, null, "Зйомка")).toBe(false);
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});
