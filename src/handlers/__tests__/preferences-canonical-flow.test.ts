import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../preferences-flow.ts", import.meta.url)),
    "utf8"
);

describe("preferences flow canonical write", () => {
    it("routes the save through the canonical writer behind the flag", () => {
        expect(source).toContain("AWS_PREFERENCES_CANONICAL_WRITE_ENABLED");
        expect(source).toContain("saveCanonicalPreference");
    });

    it("keeps the Google Sheet write only as the rollback path", () => {
        expect(source).toContain("preferencesService.savePreference");
    });

    it("never performs both writes in the same branch", () => {
        expect(source).not.toMatch(
            /saveCanonicalPreference[\s\S]{0,400}?await\s+preferencesService\.savePreference/u
        );
    });
});

/**
 * Повторный заход в поток раньше открывал ПУСТОЙ календарь: человек не видел,
 * что уже подал, и либо заполнял заново по памяти, либо не трогал вовсе.
 * Проверка «ты уже заполнила» жила только в legacy-ветке и с каноническим
 * флагом (который включён) не работала.
 */
describe("preferences flow re-entry", () => {
    it("reads the current submission before rendering the calendar", () => {
        expect(source).toContain("readCanonicalPreferenceDays");
    });

    it("seeds the calendar with the days already submitted", () => {
        expect(source).toMatch(/selectedDays:\s*prefilledDays/u);
    });

    /** Иначе подставленные отметки читаются как чужой выбор или сбой. */
    it("tells the photographer where the marked days came from", () => {
        expect(source).toContain("Ти вже надсилала побажання на цей місяць");
    });

    /**
     * Недоступный бэкенд не должен утверждать, что человек ничего не отмечал:
     * пустой календарь при сбое — прежнее поведение, а не новое сообщение.
     */
    it("only claims a previous submission when one was actually read", () => {
        expect(source).toMatch(/prefilled:\s*prefilledDays\.length > 0/u);
    });
});

/**
 * На экране подтверждения «🔄 Спочатку» и «✖️ Скасувати» стояли рядом и обе
 * читались как «отменить», хотя первая сбрасывала выбор, а вторая выбрасывала
 * всю работу молча.
 */
describe("preferences flow confirmation actions", () => {
    it("names the consequence of leaving instead of saying just cancel", () => {
        expect(source).toContain("Вийти без збереження");
    });

    it("offers editing that keeps the marked days", () => {
        expect(source).toContain("✏️ Змінити дні");
    });

    it("no longer offers a second, ambiguous way to discard the selection", () => {
        expect(source).not.toMatch(/text\("🔄 Спочатку"/u);
    });

    /** Старые экраны в чатах всё ещё шлют этот callback. */
    it("keeps handling the retired restart button", () => {
        expect(source).toContain('callbackQuery("pref_restart_flow"');
    });
});
