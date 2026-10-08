import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { pickThreadIcons } = await import("../support-thread-icons.js");

describe("іконки статусів", () => {
    it("знаходить емодзі незалежно від вариаційного селектора", () => {
        const icons = pickThreadIcons([
            { emoji: "❗️", custom_emoji_id: "w" },
            { emoji: "✅", custom_emoji_id: "a" },
            { emoji: "👀", custom_emoji_id: "e" },
            { emoji: "📁", custom_emoji_id: "r" },
        ]);
        expect(icons).toEqual({ WAITING: "w", ANSWERED: "a", ESCALATED: "e", ARCHIVED: "r" });
    });

    it("бере запасний варіант, якщо основного немає", () => {
        expect(pickThreadIcons([{ emoji: "🔥", custom_emoji_id: "f" }]).WAITING).toBe("f");
    });

    it("нічого не знайдено — null, а не чужа іконка", () => {
        expect(pickThreadIcons([{ emoji: "🎄", custom_emoji_id: "x" }]).ANSWERED).toBeNull();
    });
});
