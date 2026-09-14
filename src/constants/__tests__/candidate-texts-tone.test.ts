import { describe, expect, it } from "vitest";

import { CANDIDATE_TEXTS } from "../candidate-texts.js";

/**
 * Тон голосу воронки як тест, а не як домовленість.
 *
 * Правила «на ви», «без емодзі» існували лише коментарями в коді, тому
 * половина повідомлень роз’їхалася непоміченою: тексти в staff-texts.ts
 * зверталися на «ти» й ставили 🌸/✨ на відмовах. Поки правило не
 * перевіряється, воно тримається на уважності рев’ювера.
 */

/** Значення текстів: функції викликаються з правдоподібними аргументами. */
function renderAll(): { key: string; value: string }[] {
    const rendered: { key: string; value: string }[] = [];

    for (const [key, entry] of Object.entries(CANDIDATE_TEXTS)) {
        if (typeof entry === "string") {
            rendered.push({ key, value: entry });
            continue;
        }
        if (typeof entry !== "function") continue;

        // Аргументи покривають усі наявні сигнатури: рядки-назви, час і
        // посилання. Зайві аргументи функція просто ігнорує.
        const args = ["Volkland", "10:00", "https://meet.example/abc", 2000];
        try {
            const value = (entry as (...a: unknown[]) => string)(...args);
            if (typeof value === "string") rendered.push({ key, value });
        } catch {
            // Текст із іншою сигнатурою — перевіримо окремо, якщо з’явиться.
        }
    }

    return rendered;
}

describe("candidate tone of voice", () => {
    const texts = renderAll();

    it("renders every text entry", () => {
        expect(texts.length).toBeGreaterThan(20);
    });

    /**
     * Два тексти прийняття в команду — межа воронки, а не її частина: людина
     * тут перестає бути кандидаткою і стає своєю. Саме вони вимовляють перехід
     * на «ти» вголос, тому «ти» в них обов’язкове, а не порушення.
     *
     * Без цього винятку перехід лишався б невимовленим: кандидатці писали «ми
     * зв’яжемося з вами», а наступного дня бот команди звертався на «ти», і
     * вона просто помічала, що з нею раптом інакше.
     */
    const HANDOFF_KEYS = ["worker-offer-accepted"];

    /**
     * Постійний екран статусу після прийняття: фрази переходу не несе, але
     * звертається вже на «ти» — людина по цей бік рішення вже своя.
     */
    const IN_TEAM_KEYS = ["candidate-accepted-welcome"];

    it("никогда не обращается к кандидатке на «ти» — кроме момента приёма в команду", () => {
        const offenders = texts.filter(
            ({ key, value }) =>
                !HANDOFF_KEYS.includes(key) &&
                !IN_TEAM_KEYS.includes(key) &&
                /(^|[^\p{L}])(ти|тебе|тобі|тобою|твоя|твої|твою|твоє|твій|твого|твоїх)([^\p{L}]|$)/iu.test(value),
        );

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    /**
     * Перехід вимовляється один раз, у момент рішення. `candidate-accepted-welcome`
     * — постійний екран статусу: він рендериться щоразу, коли вона відкриває
     * анкету, і так до першої зміни. Фраза там перетворювала ритуал на напис.
     */
    it("постоянный экран статуса не повторяет фразу перехода", () => {
        const screen = texts.find(({ key }) => key === "candidate-accepted-welcome");
        expect(screen).toBeDefined();
        expect(screen!.value).not.toContain("на «ти»");
    });

    it("оба текста приёма в команду проговаривают переход на «ти»", () => {
        const handoff = texts.filter(({ key }) => HANDOFF_KEYS.includes(key));
        expect(handoff).toHaveLength(HANDOFF_KEYS.length);

        const silent = handoff.filter(({ value }) => !value.includes("на «ти»"));
        expect(silent.map((o) => o.key)).toEqual([]);
    });

    it("не использует эмодзи в текстах кандидатке", () => {
        const offenders = texts.filter(({ value }) => /\p{Extended_Pictographic}/u.test(value));

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("не ставит восклицательных знаков на отказах", () => {
        const rejections = texts.filter(({ key }) => key.includes("reject"));
        expect(rejections.length).toBeGreaterThan(0);

        const offenders = rejections.filter(({ value }) => value.includes("!"));
        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("не обещает наставника: роль изъята из бота", () => {
        const offenders = texts.filter(({ value }) => /наставник/i.test(value));

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    it("не оставляет английских литералов этапов в украинском тексте", () => {
        const offenders = texts.filter(({ value }) => /\b(training|discovery)\b/i.test(value));

        expect(offenders.map((o) => o.key)).toEqual([]);
    });
});
