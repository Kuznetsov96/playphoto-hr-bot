import { describe, expect, it } from "vitest";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";

/**
 * Ответы на нажатие кнопки Telegram показывает всплывающей плашкой поверх чата.
 * Без `show_alert` она узкая и однострочная: примерно после 45 символов текст
 * обрезается многоточием. Фотограф видела «Не вдалося зберегти відповідь. Спробуй
 * ще раз за хви...» — то есть ровно ту часть, где сказано, что делать, до неё и
 * не доходило.
 *
 * Порог намеренно ниже телеграмовских 200 байт: 200 — это когда сообщение
 * отклонят, а не когда его перестанут читать.
 */
const TOAST_LIMIT = 45;

const TOAST_TEXTS = [
    "staff-replacement-offer-accepted",
    "staff-replacement-offer-declined",
    "staff-replacement-offer-gone",
    "staff-replacement-offer-error",
    "staff-replacement-undo-done",
    "staff-replacement-undo-ans-window-closed",
    "staff-replacement-undo-ans-failed",
    "schedule-notif-ans-expired",
    "schedule-notif-ans-unavailable",
    "staff-replacement-revert-ans-failed",
    "staff-replacement-revert-ans-done",
] as const;

describe("тексты, показываемые всплывающей плашкой", () => {
    for (const key of TOAST_TEXTS) {
        it(`«${key}» помещается в одну строку`, () => {
            const text = STAFF_TEXTS[key];
            expect(typeof text).toBe("string");
            expect((text as string).length).toBeLessThanOrEqual(TOAST_LIMIT);
        });
    }

    /**
     * Текст ошибки обязан оставаться действием, а не извинением: если он всё-таки
     * попадёт в узкую плашку, первым должно читаться то, что делать.
     */
    it("ошибка отказа начинается с того, что делать", () => {
        expect(STAFF_TEXTS["staff-replacement-offer-error"]).toMatch(/^Спробуй/);
    });

    /**
     * Полные формулировки не выброшены, а переехали в плашку с кнопкой «ОК»,
     * где помещаются целиком — вместе с тем, куда обращаться, если не вышло.
     */
    it("развёрнутые варианты сохраняют, куди звертатися", () => {
        for (const key of [
            "staff-replacement-offer-error-alert",
            "schedule-notif-ans-unavailable-alert",
        ] as const) {
            expect(STAFF_TEXTS[key]).toContain("підтримку");
        }
    });
});
