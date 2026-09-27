import { readFileSync } from "node:fs";
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

    /**
     * Генератор вебаппа не ставит смены тому, кто не ответил. Прежнее
     * «зміни можуть випасти на незручні дні» обещало место в графике, которого
     * не будет, — и молчать выглядело безопасно.
     */
    it("напоминание называет последствие, которое случится на деле", () => {
        const reminder = STAFF_TEXTS["staff-preferences-reminder"]({
            monthName: "вересень",
            deadline: formatDeadline(new Date("2026-08-26T12:00:00.000Z")),
        });

        expect(reminder).toContain("у графіку на вересень тебе не буде");
        expect(reminder).toContain("26 серпня, середа");
        expect(reminder).not.toContain("незручні дні");
    });

    it("напоминание даёт выход тому, у кого нет ограничений", () => {
        const reminder = STAFF_TEXTS["staff-preferences-reminder"]({
            monthName: "вересень",
            deadline: formatDeadline(new Date("2026-08-26T12:00:00.000Z")),
        });

        // Названия настоящих кнопок: без выбранных дней в календаре нет
        // «Готово», есть «✨ Немає побажань», а сохраняет только «Зберегти».
        expect(reminder).toContain("«Немає побажань» і «Зберегти»");
    });

    it("напоминание без эмодзи и родовых форм: это графік", () => {
        const texts = [
            STAFF_TEXTS["staff-preferences-reminder"]({ monthName: "вересень", deadline: "26 серпня, середа" }),
            STAFF_TEXTS["staff-preferences-reminder-undated"],
        ];

        for (const text of texts) {
            expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
            expect(text).not.toMatch(/заповнив|заповнила/u);
        }
    });

    /**
     * Сюда попадает и опоздавший: графика у него не будет, и обещать ему
     * «підміну прямо в графіку» — неправда.
     */
    it("закрытое окно говорит, что делать дальше, и не обещает график", () => {
        const closed = STAFF_TEXTS["staff-preferences-window-closed"]({ monthName: "вересень" });

        expect(closed).toContain("звернись у підтримку");
        expect(closed).not.toContain("надішлемо його тобі");
        expect(closed).not.toContain("підміну");
        expect(closed).not.toContain("помилка");
    });

    it("везде «підміна», а не «заміна»", () => {
        // В словаре фотографов «підміна» одиннадцать раз против одного —
        // расхождение читается как речь о другой сущности.
        const all = [
            invite,
            STAFF_TEXTS["staff-preferences-reminder"]({ monthName: "вересень", deadline: "26 серпня, середа" }),
            STAFF_TEXTS["staff-preferences-window-closed"]({ monthName: "вересень" }),
        ].join("\n");

        expect(all).not.toMatch(/заміну|заміна/u);
    });
});

describe("окно напоминаний", () => {
    /**
     * Срок хранит вебапп. Бот называет его в приглашении и спрашивает заново
     * перед каждым напоминанием — своего числа 26 у бота больше нет, иначе
     * перенос срока владельцем бот бы не заметил.
     */
    it("берёт срок из вебаппа, а не из своего числа", () => {
        const source = readFileSync(
            new URL("../monthly-preferences-trigger.ts", import.meta.url),
            "utf8",
        );

        expect(source).toContain("awsBusinessClient.schedulePreferenceSchedule(targetMonth)");
        expect(source).toContain("deadline: formatLocalDate(schedule.deadline)");
        expect(source).toContain("targetMonth,");
        // `pingUntil` — только предел на крайний случай, конец месяца графика.
        expect(source).toContain("pingUntil: firstDayAfterMonth(targetMonth)");
        expect(source).not.toMatch(/DEADLINE_DAY_OF_MONTH|kyivDeadline/u);
    });
});
