import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../staff.ts", import.meta.url)), "utf8");

/**
 * Telegram ділить ширину рядка порівну між кнопками і НЕ переносить текст:
 * довша назва просто обрізається. У парі з «🗓 Мій графік» кнопка підміни
 * показувалась фотографу як «🔁 Пот...заміна».
 */
describe("staff hub button layout", () => {
    it("gives the replacement button a row of its own", () => {
        const match = /range\s*\.?text\(\s*"🔁 Шукати підміну"[\s\S]*?\}\)(\.row\(\))?/u.exec(source);

        expect(match).not.toBeNull();
        expect(match![1]).toBe(".row()");
    });

    it("closes the schedule button's row before it", () => {
        // Без цього .row() підміна лишається в парі з графіком і знову
        // ділить ширину навпіл.
        const schedule = source.indexOf('"🗓 Мій графік"');
        const replacement = source.indexOf('"🔁 Шукати підміну"');
        const between = source.slice(schedule, replacement);

        expect(schedule).toBeGreaterThan(-1);
        expect(replacement).toBeGreaterThan(schedule);
        expect(between).toContain(".row()");
    });

    it("uses the same word for a replacement as every other message does", () => {
        // «підміна» стоїть у текстах бота і в повідомленні про графік
        // («попроси підміну»). Кнопка була єдиним місцем зі словом «заміна».
        expect(source).not.toContain("Потрібна заміна");
    });
});
