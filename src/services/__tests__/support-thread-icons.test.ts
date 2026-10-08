import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/logger.js", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { pickThreadIcons } = await import("../support-thread-icons.js");

/**
 * Рішення власника 08.10: кожна зміна іконки пише в тему службовий рядок, тому
 * іконка лише для рідкісних станів — 👀 покликали і 📁 звільнена. «Чекає» і
 * «відповіли» видно з прев'ю останнього повідомлення.
 */
describe("іконки статусів", () => {
    it("чекає і відповіли — без іконки (порожній рядок знімає іконку)", () => {
        const icons = pickThreadIcons([{ emoji: "💬", custom_emoji_id: "c" }, { emoji: "✅", custom_emoji_id: "a" }]);
        expect(icons.WAITING).toBe("");
        expect(icons.ANSWERED).toBe("");
    });

    it("покликали і звільнена — з набору, незалежно від вариаційного селектора", () => {
        const icons = pickThreadIcons([{ emoji: "👀", custom_emoji_id: "e" }, { emoji: "📁", custom_emoji_id: "r" }]);
        expect(icons.ESCALATED).toBe("e");
        expect(icons.ARCHIVED).toBe("r");
    });

    it("запасний варіант, якщо основного немає", () => {
        expect(pickThreadIcons([{ emoji: "⚡️", custom_emoji_id: "z" }]).ESCALATED).toBe("z");
    });

    it("нічого не знайдено — null, а не чужа іконка", () => {
        expect(pickThreadIcons([{ emoji: "🎄", custom_emoji_id: "x" }]).ARCHIVED).toBeNull();
    });
});
