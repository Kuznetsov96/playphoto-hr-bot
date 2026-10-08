import { describe, expect, it } from "vitest";
import {
    buildThreadTitle,
    formatThreadPlace,
    isAcknowledgement,
    kyivDay,
    nextStatus,
    pickMainLocationId,
    renderThreadCard,
    surnameOf,
    threadNameLabel,
} from "../support-thread-format.js";

describe("назва постійної теми", () => {
    it("прізвище, місто і майданчик через крапку", () => {
        expect(buildThreadTitle("Бланк", "Lviv · Dragon Park 2")).toBe("Бланк · Lviv · Dragon Park 2");
    });

    it("без точки лишається лише прізвище", () => {
        expect(buildThreadTitle("Бланк", null)).toBe("Бланк");
    });

    it("обрізається до ліміту Telegram у 128 символів", () => {
        expect(buildThreadTitle("Б".repeat(200), "Lviv · X").length).toBe(128);
    });

    it("прізвище без ініціалів, коли збігу немає", () => {
        expect(threadNameLabel({ fullName: "Бланк Анастасія Ігорівна", surnameNameDot: "Бланк А." }, new Set())).toBe("Бланк");
    });

    it("ініціал додається, коли прізвище повторюється", () => {
        expect(threadNameLabel({ fullName: "Іванова Анна Олександрівна", surnameNameDot: "Іванова А." }, new Set(["Іванова"]))).toBe("Іванова А.");
    });

    it("ініціал виводиться з ПІБ, якщо surnameNameDot порожній", () => {
        expect(threadNameLabel({ fullName: "Іванова Анна", surnameNameDot: null }, new Set(["Іванова"]))).toBe("Іванова А.");
    });

    it("прізвище — перше слово ПІБ без зайвих пробілів", () => {
        expect(surnameOf("  Гут   Ольга ")).toBe("Гут");
    });
});

describe("точка в назві", () => {
    it("філія йде після майданчика", () => {
        expect(formatThreadPlace({ name: "Smile Park", branch: "Darynok", city: "Kyiv" })).toBe("Kyiv · Smile Park Darynok");
    });

    it("латинське місто береться як є", () => {
        expect(formatThreadPlace({ name: "Karamel", branch: "Prut", city: "Kolomyia" })).toBe("Kolomyia · Karamel Prut");
    });

    it("кириличне місто переводиться латиницею", () => {
        expect(formatThreadPlace({ name: "Leoland", branch: null, city: "Львів" })).toBe("Lviv · Leoland");
    });

    it("основна точка — найчастіша за змінами", () => {
        expect(pickMainLocationId([{ locationId: "a" }, { locationId: "b" }, { locationId: "b" }], "a")).toBe("b");
    });

    it("без змін — точка профілю", () => {
        expect(pickMainLocationId([], "home")).toBe("home");
    });

    it("нічия — та, що трапилась раніше", () => {
        expect(pickMainLocationId([{ locationId: "a" }, { locationId: "b" }], null)).toBe("a");
    });
});

describe("коротка подяка не вимагає відповіді", () => {
    for (const text of ["Добре, дякую", "Гаразд", "Навзаєм 🤗", "дякую велике!", "ок", "+", "👍", "Дякую)", "Зрозуміла, дякую"]) {
        it(`«${text}» — подяка`, () => expect(isAcknowledgement({ text })).toBe(true));
    }

    for (const text of ["Добре, а коли зміна?", "Дякую вам за розуміння, а гроші коли", "Можна завтра вийти", "Добре?", "Так, завтра сфотографую"]) {
        it(`«${text}» — питання`, () => expect(isAcknowledgement({ text })).toBe(false));
    }

    it("стікер — подяка", () => expect(isAcknowledgement({ sticker: {} })).toBe(true));
    it("фото з підписом «дякую» — не подяка", () => expect(isAcknowledgement({ photo: [], caption: "дякую" })).toBe(false));
    it("порожнє повідомлення без тексту — не подяка", () => expect(isAcknowledgement({ voice: {} })).toBe(false));
});

describe("статус теми", () => {
    const plain = (status: "WAITING" | "ANSWERED" | "ESCALATED" | "ARCHIVED", escalatedToTelegramId: bigint | null = null) => ({ status, escalatedToTelegramId });

    it("питання фотографині — чекає відповіді", () => {
        expect(nextStatus(plain("ANSWERED"), { kind: "staff_question" }).status).toBe("WAITING");
    });

    it("подяка статус не змінює", () => {
        expect(nextStatus(plain("WAITING"), { kind: "staff_ack" }).status).toBe("WAITING");
        expect(nextStatus(plain("ANSWERED"), { kind: "staff_ack" }).status).toBe("ANSWERED");
    });

    it("питання при ескалації лишає ескалацію", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "staff_question" })).toEqual(plain("ESCALATED", 1n));
    });

    it("відповідь не того, кого кликали, лишає ескалацію", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "support_reply", actorTelegramId: 2n })).toEqual(plain("ESCALATED", 1n));
    });

    it("відповідь того, кого кликали, знімає ескалацію", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "support_reply", actorTelegramId: 1n })).toEqual(plain("ANSWERED"));
    });

    it("👍 підтримки — відповіли", () => {
        expect(nextStatus(plain("WAITING"), { kind: "support_thumbs_up", actorTelegramId: 5n }).status).toBe("ANSWERED");
    });

    it("пост бота по задачі — чекає відповіді", () => {
        expect(nextStatus(plain("ANSWERED"), { kind: "bot_context" }).status).toBe("WAITING");
    });

    it("покликали — ескалація на ціль", () => {
        expect(nextStatus(plain("WAITING"), { kind: "escalated", targetTelegramId: 9n })).toEqual(plain("ESCALATED", 9n));
    });

    it("повернули в Support з питанням без відповіді — чекає", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "back_to_support", hasUnansweredQuestion: true })).toEqual(plain("WAITING"));
    });

    it("повернули в Support без питань — відповіли", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "back_to_support", hasUnansweredQuestion: false })).toEqual(plain("ANSWERED"));
    });

    it("архів не змінюється від подяки, але питання будить", () => {
        expect(nextStatus(plain("ARCHIVED"), { kind: "staff_ack" }).status).toBe("ARCHIVED");
        expect(nextStatus(plain("ARCHIVED"), { kind: "staff_question" }).status).toBe("WAITING");
    });

    it("звільнення — архів і без ескалації", () => {
        expect(nextStatus(plain("ESCALATED", 1n), { kind: "archived" })).toEqual(plain("ARCHIVED"));
    });
});

describe("картка людини", () => {
    const base = { today: { day: "08.10", place: null, time: null }, archivedAt: null, fullName: "Бланк Анастасія", username: null, phone: null, mainPlace: null };

    it("перший рядок — сьогодні без зміни", () => {
        expect(renderThreadCard(base).split("\n")[0]).toBe("📍 Today 08.10: no shift");
    });

    it("перший рядок — сьогоднішня точка і час", () => {
        const card = renderThreadCard({ ...base, today: { day: "08.10", place: "Lviv · Dragon Park 1", time: "10:00–20:00" } });
        expect(card.split("\n")[0]).toBe("📍 Today 08.10: Lviv · Dragon Park 1 · 10:00–20:00");
    });

    it("архів замість сьогодні", () => {
        expect(renderThreadCard({ ...base, archivedAt: "08.10" }).split("\n")[0]).toBe("📦 Employment ended 08.10");
    });

    it("ім'я, юзернейм, телефон і основна точка, HTML екранується", () => {
        const card = renderThreadCard({ ...base, fullName: "Гут <Ольга>", username: "gut", phone: "+380", mainPlace: "Lviv · Smile Park Forum Lviv" });
        expect(card).toContain("👤 Гут &lt;Ольга&gt; · @gut");
        expect(card).toContain("📞 <code>+380</code>");
        expect(card).toContain("🏠 Main point: Lviv · Smile Park Forum Lviv");
    });
});

describe("київська дата", () => {
    it("після півночі за Києвом — вже наступний день", () => {
        expect(kyivDay(new Date("2026-10-07T21:30:00Z"))).toBe("2026-10-08");
    });
});
