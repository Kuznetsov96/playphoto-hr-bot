import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";

/**
 * Щит устаревших кнопок (`handlers/index.ts`) отвечает фотографам на любую
 * кнопку, у которой нет обработчика. Его тост видит каждый, кто нажал старое
 * сообщение, — и он был по-английски: «This button is outdated. Updating menu... ✨».
 */
const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
const texts = [STAFF_TEXTS["stale-button-popup"], STAFF_TEXTS["stale-button-deactivated-popup"]];

describe("stale button shield", () => {
    it("answers from the staff dictionary, not with inline strings", () => {
        expect(source).toContain('answerCallbackQuery(STAFF_TEXTS["stale-button-popup"])');
        expect(source).toContain('answerCallbackQuery(STAFF_TEXTS["stale-button-deactivated-popup"])');
        expect(source).not.toContain("This button is outdated");
    });

    it("speaks Ukrainian, on «ти», without emoji", () => {
        for (const text of texts) {
            expect(text).not.toMatch(/[A-Za-z]/u);
            expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
            expect(text).not.toMatch(/Зверніться|Спробуйте|Натисніть/u);
        }
    });

    it("puts the action first in the narrow popup", () => {
        expect(STAFF_TEXTS["stale-button-popup"].startsWith("Відкриваю актуальне меню")).toBe(true);
    });
});
