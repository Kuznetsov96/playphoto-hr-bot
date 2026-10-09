import { describe, expect, it } from "vitest";
import { STAFF_TEXTS } from "../staff-texts.js";

/**
 * Тексти нагадувань фотографу (план 4) з правдоподібними аргументами: загальний тест тону
 * викликає функції чужим payload і бачить «undefined», тож свої правила перевіряємо тут.
 */
const sample = { client: "Олена, +380671231301", name: "Марійка", notes: "Більше кадрів", due: "вт 19.03", days: "3 дні", current: "пн 18.03", line: "Зйомка · Олена" };

function rendered(): Array<{ key: string; value: string }> {
    return Object.entries(STAFF_TEXTS)
        .filter(([key]) => key.startsWith("shoot-task-"))
        .map(([key, entry]) => ({ key, value: typeof entry === "function" ? (entry as (p: typeof sample) => string)(sample) : entry }));
}

describe("shoot task texts", () => {
    const texts = rendered();

    it("exist", () => {
        expect(texts.length).toBeGreaterThanOrEqual(30);
        expect(texts.filter(({ value }) => value.includes("undefined")).map((t) => t.key)).toEqual([]);
    });

    it("use «ти», never «ви»", () => {
        const offenders = texts.filter(({ value }) => /(^|[^\p{L}])(ви|вам|вас|ваш|ваша|ваше|ваші)([^\p{L}]|$)/iu.test(value));
        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("use the typographic apostrophe and «ялинки»", () => {
        expect(texts.filter(({ value }) => /[а-яіїєґ]'[а-яіїєґ]/iu.test(value)).map((t) => t.key)).toEqual([]);
        expect(texts.filter(({ value }) => /"/u.test(value.replace(/<[^>]+>/gu, ""))).map((t) => t.key)).toEqual([]);
    });

    it("keep deadlines dry: no emotional emoji", () => {
        const allowed = /[📍📅🕐❓]/gu;
        const offenders = texts.filter(({ value }) => /\p{Extended_Pictographic}/u.test(value.replace(allowed, "")));
        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("say «включно» with every deadline", () => {
        for (const key of ["shoot-task-assigned-due", "shoot-task-term", "shoot-task-returned-due", "shoot-task-due-changed-head"] as const) {
            expect((STAFF_TEXTS[key] as (p: typeof sample) => string)(sample)).toContain("включно");
        }
    });

    it("tell the photographer she can send from a colleague's shift", () => {
        for (const key of ["shoot-task-send-hint", "shoot-task-overdue-can-move", "shoot-task-overdue-no-move"] as const) {
            expect(STAFF_TEXTS[key]).toContain("зі своєї зміни або зі зміни колеги");
        }
    });

    it("open a support topic with a neutral line, not a guess about who wrote", () => {
        const line = (STAFF_TEXTS["shoot-task-support-open-topic"] as (p: typeof sample) => string)(sample);
        // Тему читає підтримка — англійською (AGENTS.md, аудит 09.10.2026).
        expect(line).toBe("❓ From a shoot reminder: Зйомка · Олена");
        expect(line).not.toContain("opened");
    });
});
