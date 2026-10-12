import { describe, expect, it } from "vitest";
import {
    formatChangeLine,
    formatMonthSection,
    formatMonthTotal,
    formatNewShiftsList,
    monthNameOf,
    shiftsWord,
    type MonthRow,
} from "../format-schedule-message.js";

function rows(count: number, location = "Fantasy Town Черкаси"): MonthRow[] {
    return Array.from({ length: count }, (_, index) => ({
        locationKey: location,
        shift: {
            localDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
            locationLabel: location,
            startsAtLocal: "10:00",
            endsAtLocal: "20:00",
        },
    }));
}

/** Рядки списку починаються з дня тижня (можливо, після позначки). */
const listRows = (text: string) =>
    text.split("\n").filter((row) => /^(<b>)?(нд|пн|вт|ср|чт|пт|сб) /u.test(row));

describe("formatMonthSection", () => {
    it("перечисляет весь месяц, когда смен немного", () => {
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(3), notes: [] });

        expect(text).toContain("Графік на вересень готовий");
        expect(text).toContain("У тебе <b>3</b> зміни");
        expect(listRows(text)).toHaveLength(3);
        expect(text).not.toContain("та ще");
    });

    it("выносит общую локацию в шапку — строка смены в одну строку экрана", () => {
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(3), notes: [] });

        expect(text).toContain("📍 Fantasy Town Черкаси");
        for (const row of listRows(text)) expect(row).not.toContain("Fantasy");
    });

    it("обрезает длинный опубликованный месяц и говорит, сколько осталось", () => {
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(20), notes: [] });

        expect(text).toContain("У тебе <b>20</b> змін");
        expect(listRows(text)).toHaveLength(10);
        expect(text).toContain("та ще 10 — у «Мій графік»");
        expect(text).not.toContain("11.09");
    });

    it("в изменённом месяце не прячет отмеченные строки за обрезкой", () => {
        const month = rows(20);
        month[18]!.mark = "added";
        const text = formatMonthSection({ mode: "updated", monthDate: "2026-09-01", rows: month, notes: [] });

        expect(text).toContain("<b>сб 19.09</b> · 10:00–20:00 · нова");
        expect(text).toContain("та ще 19 — у «Мій графік»");
    });

    it("никогда не превышает лимит Telegram", () => {
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(31), notes: [] });

        expect(text.length).toBeLessThan(4096);
    });

    it("считает выходные по всему месяцу и выделяет их", () => {
        // 2026-09-05 — субота, 2026-09-06 — неділя.
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(7), notes: [] });

        expect(text).toContain("У тебе <b>7</b> змін · у вихідні: <b>2</b>");
        expect(text).toContain("<b>сб 05.09</b>");
        expect(text).not.toContain("<b>вт 01.09</b>");
    });

    it("в первой публикации не ставит отметок «нова» — новое там всё", () => {
        const month = rows(2).map((row) => ({ ...row, mark: "added" as const }));
        const text = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: month, notes: [] });

        expect(text).not.toContain("нова");
    });

    it("экранирует название локации: результат уходит в Telegram как HTML", () => {
        const text = formatMonthSection({
            mode: "published",
            monthDate: "2026-09-01",
            rows: rows(1, "Fun & <Play>"),
            notes: [],
        });

        expect(text).toContain("Fun &amp; &lt;Play&gt;");
    });

    it("говорит, что делать с неподходящим днём, только в публикации", () => {
        const published = formatMonthSection({ mode: "published", monthDate: "2026-09-01", rows: rows(2), notes: [] });
        const updated = formatMonthSection({ mode: "updated", monthDate: "2026-09-01", rows: rows(2), notes: [] });

        expect(published).toContain("натисни «Шукати підміну»");
        expect(updated).not.toContain("Шукати підміну");
    });
});

describe("formatChangeLine", () => {
    const shift = rows(1)[0]!.shift;
    const later = { ...shift, startsAtLocal: "12:00" };
    const elsewhere = { ...shift, locationLabel: "Dragon Park (Lviv)" };

    it("пишет каждое событие одним стилем: «Что: день · точка · время», без значков", () => {
        const lines = [
            formatChangeLine({ kind: "added", shift }),
            formatChangeLine({ kind: "removed", shift }),
            formatChangeLine({ kind: "taken", shift }),
            formatChangeLine({ kind: "given", shift }),
            formatChangeLine({ kind: "updated", from: shift, to: later }),
            formatChangeLine({ kind: "updated", from: shift, to: elsewhere }),
        ];

        expect(lines).toEqual([
            "Нова зміна: вт 01.09 · Fantasy Town Черкаси · 10:00–20:00",
            "Знято зміну: вт 01.09 · Fantasy Town Черкаси · 10:00–20:00",
            "Зміну передано тобі: вт 01.09 · Fantasy Town Черкаси · 10:00–20:00",
            "Підміну знайдено: вт 01.09 · Fantasy Town Черкаси · 10:00–20:00",
            "Новий час: вт 01.09 · Fantasy Town Черкаси · 10:00–20:00 → 12:00–20:00",
            "Нова точка: вт 01.09 · Fantasy Town Черкаси → Dragon Park (Lviv) · 10:00–20:00",
        ]);
    });

    it("не говорит «зміна» о действии — только о рабочем дне", () => {
        const updated = formatChangeLine({ kind: "updated", from: shift, to: later });

        expect(updated).not.toMatch(/Змінено|змінена|Було|Стало/u);
    });
});

describe("подписи", () => {
    it("склоняет «зміна» по числу", () => {
        expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25].map((n) => `${n} ${shiftsWord(n)}`)).toEqual([
            "1 зміна",
            "2 зміни",
            "4 зміни",
            "5 змін",
            "11 змін",
            "12 змін",
            "14 змін",
            "21 зміна",
            "22 зміни",
            "25 змін",
        ]);
    });

    it("подводит итог месяца в местном падеже", () => {
        expect(formatMonthTotal("2026-11-01", 4, false)).toBe("Тепер у тебе в листопаді <b>4</b> зміни.");
        expect(formatMonthTotal("2026-11-01", 0, false)).toBe("У листопаді змін у тебе більше немає.");
    });

    it("в идущем месяце считает только то, что впереди — как «Мій графік»", () => {
        expect(formatMonthTotal("2026-10-01", 2, true)).toBe("Попереду в жовтні <b>2</b> зміни.");
        expect(formatMonthTotal("2026-10-01", 0, true)).toBe("До кінця жовтня змін у тебе немає.");
    });

    it("без месяца не называет числа и не говорит «готовий»", () => {
        const text = formatNewShiftsList(rows(2).map((row) => row.shift));

        expect(text).toContain("Нові зміни на вересень");
        expect(text).not.toMatch(/готовий|Змін:|<b>2<\/b>/u);
        expect(text).toContain("Повний графік — у «Мій графік».");
    });

    it("называет месяц по дате", () => {
        expect(monthNameOf("2026-09-05")).toBe("вересень");
        expect(monthNameOf("2026-01-01")).toBe("січень");
        expect(monthNameOf("garbage")).toBe("");
    });
});
