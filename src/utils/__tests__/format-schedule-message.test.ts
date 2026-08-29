import { describe, expect, it } from "vitest";
import { formatScheduleMessage, monthNameOf } from "../format-schedule-message.js";

function shifts(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        localDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
        locationLabel: "Fantasy Town Черкаси",
        startsAtLocal: "10:00",
        endsAtLocal: "20:00",
    }));
}

describe("formatScheduleMessage", () => {
    it("перечисляет все смены, когда их немного", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(3) });

        expect(text).toContain("Змін: <b>3</b>");
        expect(text).toContain("01.09");
        expect(text).toContain("03.09");
        expect(text).not.toContain("та ще");
    });

    it("обрезает длинный список и говорит, сколько осталось", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(20) });

        expect(text).toContain("Змін: <b>20</b>");
        expect(text).toContain("та ще 10");
        expect(text).not.toContain("11.09");
    });

    it("никогда не превышает лимит Telegram", () => {
        // 4096 символов — жёсткий предел: сообщение сверх него не отправится
        // вовсе, и человек не узнает свой график в день публикации.
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(31) });

        expect(text.length).toBeLessThan(4096);
    });

    it("считает выходные по всему списку и выделяет их в календаре", () => {
        // 2026-09-05 — суббота, 2026-09-06 — воскресенье.
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(7) });

        expect(text).toContain("Змін: <b>7</b> · у вихідні: <b>2</b>");
        expect(text).toContain("<b>сб 05.09</b>");
        expect(text).toContain("<b>нд 06.09</b>");
        expect(text).not.toContain("<b>вт 01.09</b>");
    });

    it("не упоминает выходные, когда их нет", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(4) });

        expect(text).toContain("Змін: <b>4</b>");
        expect(text).not.toContain("у вихідні");
    });

    it("сортирует по дате независимо от порядка входа", () => {
        const text = formatScheduleMessage({
            monthName: "вересень",
            shifts: [...shifts(3)].reverse(),
        });

        expect(text.indexOf("01.09")).toBeLessThan(text.indexOf("03.09"));
    });

    it("экранирует название локации: результат уходит в Telegram как HTML", () => {
        const text = formatScheduleMessage({
            monthName: "вересень",
            shifts: [{ ...shifts(1)[0]!, locationLabel: "Fun & <Play>" }],
        });

        expect(text).toContain("Fun &amp; &lt;Play&gt;");
    });

    it("не рвёт список посередине строки", () => {
        // Обрезка по числу строк, а не по символам: обрубленная дата хуже,
        // чем честное «та ще N».
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(20) });

        // Строки списка начинаются с короткого дня недели —
        // по этому признаку они и отличаются от текста вокруг.
        const listRows = text.split("\n").filter((row) => /^(<b>)?(нд|пн|вт|ср|чт|пт|сб) /u.test(row));

        expect(listRows).toHaveLength(10);
        for (const row of listRows) {
            expect(row).toMatch(/^(<b>)?\S{2} \d{2}\.\d{2}(<\/b>)? · .+ · \d{2}:\d{2}–\d{2}:\d{2}$/u);
        }
    });

    it("говорит человеку, что делать с неподходящим днём", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(2) });

        expect(text).toContain("попроси підміну");
    });

    it("называет месяц по дате", () => {
        expect(monthNameOf("2026-09-05")).toBe("вересень");
        expect(monthNameOf("2026-01-01")).toBe("січень");
        expect(monthNameOf("garbage")).toBe("");
    });
});
