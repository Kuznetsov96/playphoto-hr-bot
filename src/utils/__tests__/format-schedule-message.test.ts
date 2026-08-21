import { describe, expect, it } from "vitest";
import { formatScheduleMessage } from "../format-schedule-message.js";

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

        expect(text).toContain("У тебе 3 зміни");
        expect(text).toContain("01.09");
        expect(text).toContain("03.09");
        expect(text).not.toContain("та ще");
    });

    it("обрезает длинный список и говорит, сколько осталось", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(20) });

        expect(text).toContain("У тебе 20 змін");
        expect(text).toContain("та ще 10");
        expect(text).not.toContain("11.09");
    });

    it("никогда не превышает лимит Telegram", () => {
        // 4096 символов — жёсткий предел: сообщение сверх него не отправится
        // вовсе, и человек не узнает свой график в день публикации.
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(31) });

        expect(text.length).toBeLessThan(4096);
    });

    it("склоняет «зміна» по числу", () => {
        expect(formatScheduleMessage({ monthName: "вересень", shifts: shifts(1) })).toContain(
            "1 зміна",
        );
        expect(formatScheduleMessage({ monthName: "вересень", shifts: shifts(2) })).toContain(
            "2 зміни",
        );
        expect(formatScheduleMessage({ monthName: "вересень", shifts: shifts(5) })).toContain(
            "5 змін",
        );
        // 11–14 — исключение: «одинадцять змін», а не «зміна».
        expect(formatScheduleMessage({ monthName: "вересень", shifts: shifts(11) })).toContain(
            "11 змін",
        );
    });

    it("не рвёт список посередине строки", () => {
        // Обрезка по числу строк, а не по символам: обрубленная дата хуже,
        // чем честное «та ще N».
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(20) });

        // Строки списка начинаются с двух пробелов и короткого дня недели —
        // по этому признаку они и отличаются от текста вокруг.
        const listRows = text.split("\n").filter((row) => /^ {2}(нд|пн|вт|ср|чт|пт|сб) /u.test(row));

        expect(listRows).toHaveLength(10);
        for (const row of listRows) {
            expect(row).toMatch(/^ {2}\S{2} \d{2}\.\d{2} {3}.+ {4}\d{2}:\d{2}–\d{2}:\d{2}$/u);
        }
    });

    it("говорит человеку, что делать с неподходящим днём", () => {
        const text = formatScheduleMessage({ monthName: "вересень", shifts: shifts(2) });

        expect(text).toContain("попроси підміну");
    });
});
