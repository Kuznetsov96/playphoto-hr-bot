import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Имя статьи ДДС для локации.
 *
 * Читается из исходника, а не импортируется: DDS_ARTICLE_MAPPING не
 * экспортируется, а делать его публичным ради теста значило бы расширять
 * поверхность модуля под нужды проверки.
 */
const source = readFileSync(
    path.resolve(__dirname, "../../finance-report.ts"),
    "utf8"
);
const block = /const DDS_ARTICLE_MAPPING[^{]*\{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? "";
const mapping = new Map(
    [...block.matchAll(/"([a-z0-9_-]+)":\s*"([^"]+)"/gu)].map((m) => [m[1]!, m[2]!])
);

/**
 * Статьи выручки, существующие в ДДС вебаппа. Снимок прода на 22.08.2026.
 *
 * Захардкожен намеренно: тест обязан падать, когда бот начинает называть статью
 * так, как её в вебаппе не зовут — а живой запрос к API сделал бы тест зелёным
 * ровно в тот момент, когда кто-то заведёт статью под неверным именем.
 */
const WEBAPP_REVENUE_ARTICLES = new Set([
    "Выручка Fantasy Town Черкассы",
    "Выручка от продаж",
    "Выручка от продаж Dragon Park",
    "Выручка от продаж Drive City",
    "Выручка от продаж Dytyache Horyshche",
    "Выручка от продаж Fly Kids 2 Киев",
    "Выручка от продаж Fly Kids Киев",
    "Выручка от продаж Fly Kids Кременчуг",
    "Выручка от продаж Fly Kids (Патона)",
    "Выручка от продаж Fly Kids Ровно",
    "Выручка от продаж Karamel Sambir",
    "Выручка от продаж Kidlandia Київ",
    "Выручка от продаж Leolend",
    "Выручка от продаж Smile Park Kharkiv",
    "Выручка от продаж Smile Park Lviv",
    "Выручка от продаж Smile Park Київ",
    "Выручка от продаж Smile Park Київ (Даринок)",
    "Выручка от продаж Volkland",
    "Выручка от продаж Volkland 2",
    "Выручка от продаж Volkland 3",
    "Выручка от продаж Каремель Коломия",
    "Выручка от продаж Каремель Шептицкий",
]);

describe("DDS article mapping", () => {
    it("names only articles that exist in the webapp ledger", () => {
        // Локация без записи здесь получает имя, собранное из справочника бота:
        // `Выручка от продаж ${name} ${city}`. При проводке через API такое имя
        // не находится, и выручка теряется молча — как случилось бы с Kidlandia,
        // у которой город записан латиницей.
        const unknown = [...mapping.entries()].filter(
            ([, article]) => !WEBAPP_REVENUE_ARTICLES.has(article)
        );
        expect(unknown).toEqual([]);
    });

    it("covers Kidlandia, whose generated name would be latin", () => {
        expect(mapping.get("kidlandia_kyiv")).toBe("Выручка от продаж Kidlandia Київ");
    });

    it("maps every location to a distinct article", () => {
        // Две локации на одну статью означали бы, что их выручка сливается в
        // один разрез и разделить её потом нечем.
        const articles = [...mapping.values()];
        expect(new Set(articles).size).toBe(articles.length);
    });
});
