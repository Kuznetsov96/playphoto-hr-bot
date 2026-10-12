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

/** Предложение съёмки (часть C): тексты дословно из таблицы «Сообщения части C» спека. */
describe("shoot offer texts", () => {
    const offerSample = { location: "Dragon Park 1 (Lviv)", date: "сб 16.03", amount: "600" };
    const texts = Object.entries(STAFF_TEXTS)
        .filter(([key]) => key.startsWith("shoot-offer-"))
        .map(([key, entry]) => ({
            key,
            value: typeof entry === "function" ? (entry as (p: typeof offerSample) => string)(offerSample) : entry,
        }));

    it("exist and render without holes", () => {
        expect(texts.length).toBeGreaterThanOrEqual(19);
        expect(texts.filter(({ value }) => value.includes("undefined")).map((t) => t.key)).toEqual([]);
    });

    it("are the spec's words", () => {
        const t = STAFF_TEXTS;
        expect(t["shoot-offer-head"]).toBe("🆕 Зйомка — можеш взяти.");
        expect(t["shoot-offer-fee"](offerSample)).toBe("Оплата — 600 грн.");
        expect(t["shoot-offer-first-wins"]).toBe("Хто перший погодиться — за тим і зйомка.");
        expect(t["shoot-offer-taken-head"]).toBe("✅ Зйомка твоя.");
        expect(t["shoot-offer-taken-undo-hint"]).toBe("Якщо натиснула помилково — скасуй протягом 15 хвилин.");
        expect(t["shoot-offer-closed-taken"](offerSample)).toBe("Цю зйомку вже взяли: Dragon Park 1 (Lviv), сб 16.03.");
        expect(t["shoot-offer-closed"](offerSample)).toBe("Пропозицію закрито: Dragon Park 1 (Lviv), сб 16.03.");
        expect(t["shoot-offer-reopened"](offerSample)).toBe(
            "Зйомка на Dragon Park 1 (Lviv) сб 16.03 знову вільна — та, що погодилась, скасувала це одразу.\nЯкщо можеш — бери.",
        );
        expect([t["shoot-offer-btn-take"], t["shoot-offer-btn-decline"], t["shoot-offer-btn-undo"]]).toEqual(["✅ Беру", "🚫 Не можу", "Скасувати"]);
        expect([
            t["shoot-offer-ans-taken"],
            t["shoot-offer-ans-already-taken"],
            t["shoot-offer-ans-declined"],
            t["shoot-offer-ans-started"],
            t["shoot-offer-ans-ineligible"],
            t["shoot-offer-ans-already-answered"],
            t["shoot-offer-ans-undone"],
            t["shoot-offer-ans-undo-closed"],
        ]).toEqual([
            "Зйомка твоя — деталі нижче.",
            "Зйомку вже взяли — хтось був раніше 💛",
            "Зрозуміло, дякуємо за відповідь 💛",
            "Зйомка вже почалась.",
            "У тебе в цей час зміна або зйомка.",
            "Ти вже відповіла на цю пропозицію.",
            "Скасовано, зйомка знову вільна 💛",
            "Скасувати вже не можна — напиши в підтримку.",
        ]);
    });

    it("use «ти», never «ви»", () => {
        const offenders = texts.filter(({ value }) => /(^|[^\p{L}])(ви|вам|вас|ваш|ваша|ваше|ваші)([^\p{L}]|$)/iu.test(value));
        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("keep the money dry: no 💛 next to the fee or in the offer itself", () => {
        for (const key of ["shoot-offer-fee", "shoot-offer-head", "shoot-offer-first-wins"] as const) {
            const entry = STAFF_TEXTS[key];
            const value = typeof entry === "function" ? entry(offerSample) : entry;
            expect(value).not.toContain("💛");
        }
    });
});
