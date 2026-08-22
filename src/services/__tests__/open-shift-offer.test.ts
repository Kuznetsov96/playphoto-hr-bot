import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";

const dispatcher = readFileSync(
    fileURLToPath(new URL("../replacement-notification-dispatcher.ts", import.meta.url)),
    "utf8",
);

describe("open shift offer text", () => {
    /**
     * Вакансію ніхто не просив підмінити — на зміні просто немає фотографа.
     * Слово «підміна» тут збрехало б про те, що хтось зник.
     */
    it("never implies somebody dropped out", () => {
        const text = STAFF_TEXTS["staff-open-shift-offer"]({
            location: "Fly Kids · Львів",
            date: "24 серпня",
            time: "14:00-21:00",
        });

        expect(text).not.toMatch(/підмін|замін/iu);
    });

    it("says the shift is free to take", () => {
        const text = STAFF_TEXTS["staff-open-shift-offer"]({
            location: "Fly Kids · Львів",
            date: "24 серпня",
            time: "14:00-21:00",
        });

        expect(text).toMatch(/вільна зміна/iu);
    });

    it("carries the venue, since locations share names", () => {
        // 13 з 20 локацій ділять назву — без міста людина поїде не туди.
        const text = STAFF_TEXTS["staff-open-shift-offer"]({
            location: "Fly Kids · Львів",
            date: "24 серпня",
            time: "14:00-21:00",
        });

        expect(text).toContain("Fly Kids · Львів");
        expect(text).toContain("24 серпня");
    });

    it("offers both answers on its own buttons", () => {
        expect(STAFF_TEXTS["staff-open-shift-btn-accept"]).toBeTruthy();
        expect(STAFF_TEXTS["staff-open-shift-btn-decline"]).toBeTruthy();
    });
});

describe("open shift offer delivery", () => {
    it("renders its own kind rather than falling through to a replacement text", () => {
        expect(dispatcher).toContain('case "OPEN_SHIFT_OFFER"');
        expect(dispatcher).toContain('staff-open-shift-offer');
    });

    it("signs its callbacks, like every other offer button", () => {
        // Непідписаний callback можна підробити: чуже предложення прийняли б
        // за своє. Перевіряємо саме виклик підпису, а не згадку константи.
        for (const code of [
            "OPEN_SHIFT_OFFER_ACCEPT_CALLBACK_CODE",
            "OPEN_SHIFT_OFFER_DECLINE_CALLBACK_CODE",
        ]) {
            expect(dispatcher).toMatch(
                new RegExp(`buildSignedCallback\\(\\s*${code}`, "u"),
            );
        }
    });

    it("still marks an unrecognised kind failed rather than crashing", () => {
        // Бекенд може додати вид, якого цей бот ще не знає: рядок має піти
        // в retry, а не покласти весь прохід.
        expect(dispatcher).toContain("INVALID_PAYLOAD_REASON");
    });
});
