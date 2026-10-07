import { describe, expect, it } from "vitest";
import { sanitizeCallbackData, sanitizeTextForLogs } from "../log-sanitizer.js";

describe("sanitizeCallbackData", () => {
    it("підписана кнопка лишає код, без id слота й підпису", () => {
        expect(sanitizeCallbackData("cb:rb:0f8fad5b-d9cb-469f-a165-70867728950e:a1b2c3d4e5")).toBe("cb:rb");
        expect(sanitizeCallbackData("cb:cwi:none:a1b2c3d4e5")).toBe("cb:cwi");
    });

    it("кнопка меню — меню й позиція, без відбитка", () => {
        expect(sanitizeCallbackData("candidate-city/0/2//h\u0000ÿ")).toBe("candidate-city/0/2");
    });

    it("інші дії — як і раніше", () => {
        expect(sanitizeCallbackData("start_scheduling")).toBe("start_scheduling");
        expect(sanitizeCallbackData("book_slot_0f8fad5b")).toBe("book_slot_0f8fad5b");
    });
});

describe("sanitizeTextForLogs: телефони", () => {
    it.each([
        ["Клієнт: Олена, +380671231301", "Клієнт: Олена, …1301"],
        ["дзвони +38 (067) 123-13-01 після 15:00", "дзвони …1301 після 15:00"],
        ["380671231301", "…1301"],
        ["0671231301 або 067 123 13 01", "…1301 або …1301"],
        ["+44 20 7946 0958", "…0958"],
    ])("%s → %s", (input, expected) => {
        expect(sanitizeTextForLogs(input)).toBe(expected);
    });

    it("телефон далі 160-го символу не виживає й частково після обрізання", () => {
        const text = `${"а".repeat(150)} +380671231301`;
        expect(sanitizeTextForLogs(text)).not.toMatch(/\d{5}/u);
    });

    it.each([
        "Сума 1600 грн",
        "📅 сб 16.03, 15:00–16:00, 17:00–18:00",
        "1600 1200 3000 2500",
        "Термін — вт 19.03.2030 включно.",
        "ДН 2 год, ставка 400",
        "Chat 1164289764 not found",
        "retry at 1791374328915 failed",
    ])("звичайні числа лишаються: %s", (input) => {
        expect(sanitizeTextForLogs(input)).toBe(input);
    });
});
