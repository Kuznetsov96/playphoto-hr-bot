import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { pickThreadIcons } = await import("../support-thread-icons.js");

describe("іконки статусів", () => {
    it("знаходить емодзі незалежно від вариаційного селектора", () => {
        const icons = pickThreadIcons([
            { emoji: "❗️", custom_emoji_id: "loud" },
            { emoji: "💬", custom_emoji_id: "w" },
            { emoji: "✅", custom_emoji_id: "a" },
            { emoji: "👀", custom_emoji_id: "e" },
            { emoji: "📁", custom_emoji_id: "r" },
        ]);
        expect(icons).toEqual({ WAITING: "w", ANSWERED: "a", ESCALATED: "e", ARCHIVED: "r" });
    });

    it("«чекає відповіді» — спокійна 💬, а не ❗️ (рішення власника 08.10)", () => {
        expect(pickThreadIcons([{ emoji: "❗️", custom_emoji_id: "loud" }, { emoji: "💬", custom_emoji_id: "calm" }]).WAITING).toBe("calm");
    });

    it("«відповіли» ніколи не бере ту саму 💬", () => {
        expect(pickThreadIcons([{ emoji: "💬", custom_emoji_id: "calm" }]).ANSWERED).toBeNull();
    });

    it("бере запасний варіант, якщо основного немає", () => {
        expect(pickThreadIcons([{ emoji: "🔥", custom_emoji_id: "f" }]).WAITING).toBe("f");
    });

    it("нічого не знайдено — null, а не чужа іконка", () => {
        expect(pickThreadIcons([{ emoji: "🎄", custom_emoji_id: "x" }]).ANSWERED).toBeNull();
    });
});
