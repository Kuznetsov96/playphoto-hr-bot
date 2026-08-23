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

/**
 * A failed save used to leave the person with nothing to press: the confirmation screen had
 * already been replaced by "⏳ Зберігаю...", and the failure was a plain reply with no buttons.
 * The session data survived, so retrying was possible — just not reachable.
 */
describe("preferences flow save failure", () => {
    it("returns to the confirmation screen so the save can be retried", () => {
        expect(source).toContain("async function failSave");
        expect(source).toMatch(/async function failSave[\s\S]{0,1200}renderConfirmation\(ctx\)/u);
    });

    it("uses the same recovery for every failure path", () => {
        // Month unresolvable, canonical write refused, and the outer catch. The
        // refusal path passes a reason-specific message, so it is matched loosely.
        expect(source.match(/await failSave\(\s*ctx,\s*\n?\s*waitMessageId/gu)?.length).toBe(3);
    });

    /** The outer catch left "⏳ Зберігаю..." on screen beside the error. */
    it("clears the saving notice even on an unexpected error", () => {
        expect(source).toMatch(/catch \(e: any\)[\s\S]{0,300}failSave\(ctx, waitMessageId\)/u);
    });

    it("logs why the canonical write was refused", () => {
        expect(source).toContain("Canonical preference save failed");
    });

    /**
     * A closed collection window is not a failure to retry — pressing again cannot reopen it, so
     * offering the confirmation screen back would promise something untrue. Every other reason is
     * transient and does get the retry.
     */
    it("does not offer a retry when the window has closed", () => {
        expect(source).toMatch(/saved\.reasonCode !== "SCHEDULE_PREFERENCES_CLOSED"/u);
        expect(source).toMatch(/if \(canRetry\) await renderConfirmation\(ctx\)/u);
    });

    /** The reason-specific wording upstream added must survive the retry screen. */
    it("keeps the reason-specific message rather than a generic one", () => {
        expect(source).toMatch(/preferenceSaveFailureText\(saved\.reasonCode/u);
    });
});

/**
 * The write is version-checked, so a second tap cannot corrupt anything — it gets a 409. But the
 * person would see an error immediately after a successful save, which reads as "it didn't work".
 */
describe("preferences flow double submit", () => {
    it("ignores a second tap on save within a short window", () => {
        expect(source).toContain("ActionDedupeWindow");
        expect(source).toMatch(/saveDedupe\.tryAcquire\(`pref-save:\$\{telegramId\}`\)/u);
    });

    it("answers the duplicate tap quietly rather than with an error", () => {
        expect(source).toMatch(/tryAcquire[\s\S]{0,200}answerCallbackQuery\("⏳ Зберігаю…"\)/u);
    });

    /**
     * The window guards a save in flight, not a deliberate retry. Without releasing it, the
     * "try again" the failure screen offers would silently do nothing for the rest of the
     * window — exactly when a person presses it.
     */
    it("frees the debounce so the offered retry actually works", () => {
        expect(source).toMatch(/async function failSave[\s\S]{0,600}saveDedupe\.release/u);
    });
});
