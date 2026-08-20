import { describe, expect, it } from "vitest";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { buildAnsweredOfferText } from "../replacement-offer-answered-text.js";

/**
 * После ответа сообщение переписывается на месте, а не остаётся с мёртвыми
 * кнопками и не дублируется новым. Причина — привязка: в тексте оффера уже есть
 * локация, дата и час, и исход должен читаться там же. Отдельное сообщение
 * оторвало бы «Зміна твоя» от смены, о якій ідеться, а при 19 оферах на один
 * пошук ще й засмітило б стрічку.
 *
 * Источник деталей — исходный текст сообщения, а НЕ ответ бэкенда: бэкенд
 * отдаёт время в UTC, и смена на 14:00 за Києвом показалась б як 11:00.
 */
const OFFER_TEXT = `🔔 Потрібна підміна на зміну — можливо, тобі підійде.

📍 Smile Park (Forum Lviv) (Lviv)
📅 20.08
🕐 14:00-21:00

Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛`;

describe("buildAnsweredOfferText", () => {
    it("после приёма сохраняет детали смены и говорит, где смотреть", () => {
        const text = buildAnsweredOfferText(OFFER_TEXT, "accepted");

        expect(text).toContain("Smile Park (Forum Lviv) (Lviv)");
        expect(text).toContain("20.08");
        expect(text).toContain("14:00-21:00");
        expect(text).toContain("Мій графік");
        // Приглашение нажать кнопку исчезает — кнопок больше нет.
        expect(text).not.toContain("тисни «Не можу»");
    });

    /**
     * Отказ — «тише в ленте»: одна строка вместо карточки. Фотограф уже решила,
     * возвращаться к этой смене ей незачем, но след должен остаться читаемым.
     */
    it("после отказа сворачивается в одну строку с местом и датой", () => {
        const text = buildAnsweredOfferText(OFFER_TEXT, "declined");

        expect(text.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
        expect(text).toContain("Smile Park (Forum Lviv) (Lviv)");
        expect(text).toContain("20.08");
    });

    it("после чужого отклика объясняет, почему кнопка больше не работает", () => {
        const text = buildAnsweredOfferText(OFFER_TEXT, "gone");

        expect(text).toContain("Smile Park (Forum Lviv) (Lviv)");
        expect(text).toContain("20.08");
        expect(text).toMatch(/закрит|раніше/u);
    });

    /**
     * Текст оффера бывает и другим: у кандидатки, отметившей день занятым,
     * первая строка иная. Разбор опирается на строки-маркеры 📍📅🕐, а не на
     * порядковый номер строки.
     */
    it("разбирает и вариант для отметившей день занятым", () => {
        const unavailable = `🌸 Знаємо, що ти позначала цей день як зайнятий — і це ок.
Просто на випадок, якщо плани змінилися: зміна ще вільна.

📍 Dragon Park 2 (Lviv)
📅 22.08
🕐 12:00-21:00

Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛`;

        const text = buildAnsweredOfferText(unavailable, "accepted");

        expect(text).toContain("Dragon Park 2 (Lviv)");
        expect(text).toContain("22.08");
        expect(text).toContain("12:00-21:00");
    });

    /**
     * Если текст не разобрался — сообщение всё равно должно перестать выглядеть
     * действующим. Исход без деталей лучше, чем живая на вид кнопка.
     */
    it("не падает на неожиданном тексте и всё равно называет исход", () => {
        const text = buildAnsweredOfferText("щось геть інше", "accepted");

        expect(text).toBeTruthy();
        expect(text).toMatch(/графік|Зміна/u);
    });

    it("экранирует HTML в названии локации", () => {
        const nasty = `🔔 Потрібна підміна на зміну — можливо, тобі підійде.

📍 <b>Park</b> (Lviv)
📅 20.08
🕐 14:00-21:00

Якщо не можеш — тисни «Не можу», нічого пояснювати не треба 💛`;

        const text = buildAnsweredOfferText(nasty, "declined");

        expect(text).not.toContain("<b>");
        expect(text).toContain("&lt;b&gt;");
    });
});

/**
 * Контракт между отправкой и перепиской: разбор читает ровно те строки, которые
 * рисует `renderCandidateMessage`. Если карточку офера когда-нибудь переверстают
 * без 📍/📅, разбор молча начнёт возвращать «bare»-вариант и фотограф перестанет
 * бачити, про яку зміну йдеться. Эта проверка ловит такой рассинхрон.
 */
describe("контракт с текстом, который реально отправляется", () => {
    it("карточка офера содержит маркеры, по которым идёт разбор", () => {
        const offer = STAFF_TEXTS["staff-replacement-offer"]({
            location: "Smile Park (Forum Lviv) (Lviv)",
            date: "20.08",
            time: "14:00-21:00",
        });

        expect(offer).toContain("📍");
        expect(offer).toContain("📅");
        expect(offer).toContain("🕐");
        expect(buildAnsweredOfferText(offer, "accepted")).toContain("Smile Park (Forum Lviv) (Lviv)");
    });

    it("вариант для отметившей день занятым — тоже", () => {
        const offer = STAFF_TEXTS["staff-replacement-offer-unavailable-wave"]({
            location: "Dragon Park 2 (Lviv)",
            date: "22.08",
            time: "12:00-21:00",
        });

        expect(buildAnsweredOfferText(offer, "declined")).toContain("Dragon Park 2 (Lviv)");
    });
});
