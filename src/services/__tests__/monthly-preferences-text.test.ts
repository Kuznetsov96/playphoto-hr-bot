import { describe, expect, it } from "vitest";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { formatDeadline } from "../../utils/format-deadline.js";

/**
 * Текст рассылки 23-го числа. Проверяется здесь, а не через сам триггер:
 * тот тянет Redis, очередь и Telegram, а проверить надо слова.
 */
describe("приглашение заполнить пожелания", () => {
    const invite = STAFF_TEXTS["staff-preferences-invite"]({
        monthName: "вересень",
        deadline: formatDeadline(new Date("2026-08-26T12:00:00.000Z")),
    });

    it("называет дедлайн датой и днём недели, а не «через N днів»", () => {
        expect(invite).toContain("до 26 серпня, середа");
        expect(invite).not.toMatch(/\d+\s+дн[іяв]/u);
    });

    it("объясняет, зачем это человеку, а не только нам", () => {
        expect(invite).toContain("врахуємо їх");
    });

    it("не грозит последствиями в первом сообщении", () => {
        // Угроза в приглашении портит тон, а до дедлайна ещё есть время.
        // Последствие названо в напоминании, где оно уместно.
        expect(invite).not.toContain("без твоїх побажань");
        expect(invite).not.toContain("нагадувати");
    });

    it("обходится без родовых форм", () => {
        // Словарь фотографов их не использует: состав команды может смениться,
        // а текст переживает смену.
        expect(invite).not.toMatch(/заповнила|побачила|готова|змогла/u);
    });

    it("напоминание называет последствие конкретно", () => {
        const reminder = STAFF_TEXTS["staff-preferences-reminder"]({
            monthName: "вересень",
            deadline: formatDeadline(new Date("2026-08-26T12:00:00.000Z")),
        });

        expect(reminder).toContain("зміни можуть випасти на незручні дні");
    });

    it("закрытое окно говорит, что делать дальше, а не «помилка»", () => {
        const closed = STAFF_TEXTS["staff-preferences-window-closed"]({ monthName: "вересень" });

        expect(closed).toContain("попросити підміну");
        expect(closed).not.toContain("помилка");
    });

    it("везде «підміна», а не «заміна»", () => {
        // В словаре фотографов «підміна» одиннадцать раз против одного —
        // расхождение читается как речь о другой сущности.
        const all = [
            invite,
            STAFF_TEXTS["staff-preferences-window-closed"]({ monthName: "вересень" }),
        ].join("\n");

        expect(all).not.toMatch(/заміну|заміна/u);
    });
});
