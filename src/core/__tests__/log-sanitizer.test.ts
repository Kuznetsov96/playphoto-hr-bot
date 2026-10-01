import { describe, expect, it } from "vitest";
import { sanitizeCallbackData } from "../log-sanitizer.js";

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
