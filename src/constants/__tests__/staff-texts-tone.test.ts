import { describe, expect, it } from "vitest";

import { STAFF_TEXTS } from "../staff-texts.js";

/**
 * Тон голосу команди як тест, а не як домовленість — парний до
 * `candidate-texts-tone.test.ts` і за тією самою причиною: правила, що живуть
 * лише коментарями, тримаються на уважності рев’ювера й тихо роз’їжджаються.
 *
 * Словник команди відрізняється від воронки двома речами: тут звертаються на
 * «ти» і тут дозволені емодзі. Але дозволені не будь-як — ролей рівно три:
 * маркер поля (📍 📅 🕐), статус дії (✅ ❌ ⚠️) і один підпис-пом’якшувач у
 * кінці. Решта — прикраса, яка робить голос молодшим за аудиторію.
 */

/** Значення текстів: функції викликаються з правдоподібними аргументами. */
function renderAll(): { key: string; value: string }[] {
    const rendered: { key: string; value: string }[] = [];

    for (const [key, entry] of Object.entries(STAFF_TEXTS)) {
        if (typeof entry === "string") {
            rendered.push({ key, value: entry });
            continue;
        }
        if (typeof entry !== "function") continue;

        // Тексти команди приймають об’єкт-payload; зайві поля функція ігнорує.
        const payload = {
            location: "Volkland",
            date: "19.09",
            time: "12:00-21:00",
            error: "помилка",
            link: "https://example.test/a",
            requesterName: "Оля",
            candidateName: "Іра",
            name: "Оля",
            amount: "2400",
            reason: "причина",
        };
        try {
            const value = (entry as (...a: unknown[]) => string)(payload);
            if (typeof value === "string") rendered.push({ key, value });
        } catch {
            // Текст з іншою сигнатурою — перевіримо окремо, якщо з’явиться.
        }
    }

    return rendered;
}

/** Маркери полів і статуси — структура, а не емоція: у ліміт не рахуються. */
const STRUCTURAL = /[📍📅🕐✅❌⚠️🔎🆕↩️🔗⏳👋🎫🛠🎂📸🔔🆘📤👤📊💬]/gu;

/** Тексти українською: службові англомовні панелі адмінів під правила не підпадають. */
function isUkrainian(value: string): boolean {
    return /[а-яіїєґА-ЯІЇЄҐ]/u.test(value);
}

describe("staff tone of voice", () => {
    const texts = renderAll().filter(({ value }) => isUkrainian(value));

    it("renders every text entry", () => {
        expect(texts.length).toBeGreaterThan(50);
    });

    /**
     * Найгірше місце для емодзі: людина не зрозуміла, що зламалось, а бот
     * ставить квіточку. Саме так виглядало «Спробуй ще раз 🌸».
     */
    it("не ставит эмодзи в сообщениях об ошибках", () => {
        const errors = texts.filter(
            ({ key, value }) =>
                /error|failed|fail/i.test(key) ||
                /не вдалося|не вийшло|не збереглося/i.test(value),
        );
        expect(errors.length).toBeGreaterThan(0);

        // ⚠️/❌ тут доречні — вони називають стан, а не пом’якшують його.
        // Ловимо саме емоційні: 😊 у помилці імені, 💛/🌸 наприкінці збою.
        const offenders = errors.filter(({ value }) =>
            /\p{Extended_Pictographic}/u.test(value.replace(STRUCTURAL, "")),
        );

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    /**
     * Один емоційний емодзі на повідомлення. Два «теплих» символи поруч
     * розмивають обидва — саме це робило привітання схожим на розсилку.
     */
    it("не больше одного эмоционального эмодзи на текст", () => {
        const offenders = texts.filter(({ value }) => {
            const emotional = value
                .replace(STRUCTURAL, "")
                .match(/\p{Extended_Pictographic}/gu);
            return (emotional?.length ?? 0) > 1;
        });

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    /**
     * Словник команди — на «ти». Три тексти про базу знань казали «ваше
     * посилання» й роз’їхалися з рештою непоміченими.
     */
    it("не обращается к своим на «ви»", () => {
        const offenders = texts.filter(({ value }) =>
            /(^|[^\p{L}])(ви|вам|вас|вами|ваше|ваш|ваша|ваші|вашого|ваших)([^\p{L}]|$)/iu.test(
                value,
            ),
        );

        expect(offenders.map((o) => o.key)).toEqual([]);
    });

    /**
     * Прямий апостроф — друкарська помилка, а не варіант: у словнику воронки
     * скрізь типографський, у словнику команди їх було змішано.
     */
    it("использует типографский апостроф", () => {
        const offenders = texts.filter(({ value }) =>
            /[а-яіїєґА-ЯІЇЄҐ]'[яюєїЯЮЄЇ]/u.test(value),
        );

        expect(offenders.map((o) => o.key)).toEqual([]);
    });
});
