import { describe, expect, it } from "vitest";

import { getErrorScreenTexts } from "../error-screen-texts.js";

/**
 * Загальний екран збою бачать і кандидатки, і співробітниці. Раніше обом
 * ішло «Ой, щось пішло не так!» на «ти» з 🐾 і ✨ (аудит 01.10.2026).
 */
describe("getErrorScreenTexts", () => {
    it("кандидатке — на «ви»", () => {
        const texts = getErrorScreenTexts({ staffProfile: null });

        expect(texts.generic).toBe("<b>Не вдалося виконати дію</b>\n\nНатисніть /start і спробуйте ще раз.");
        expect(texts.staleScreen).toBe("Цей екран уже застарів. Натисніть /start, щоб відкрити актуальне меню.");
    });

    it("сотруднице с активным профилем — на «ти»", () => {
        const texts = getErrorScreenTexts({ staffProfile: { isActive: true } });

        expect(texts.generic).toBe("<b>Не вдалося виконати дію</b>\n\nНатисни /start і спробуй ще раз.");
        expect(texts.staleScreen).toBe("Цей екран уже застарів. Натисни /start, щоб відкрити актуальне меню.");
    });

    it("неактивный профиль и незагруженный пользователь — версия кандидатки", () => {
        expect(getErrorScreenTexts({ staffProfile: { isActive: false } }).generic).toContain("Натисніть");
        expect(getErrorScreenTexts(null).generic).toContain("Натисніть");
        expect(getErrorScreenTexts(undefined).staleScreen).toContain("Натисніть");
    });
});
