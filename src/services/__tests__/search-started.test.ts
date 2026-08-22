import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";

const dispatcher = readFileSync(
    fileURLToPath(new URL("../replacement-notification-dispatcher.ts", import.meta.url)),
    "utf8",
);
const client = readFileSync(
    fileURLToPath(new URL("../aws-business-client.ts", import.meta.url)),
    "utf8",
);

const text = () =>
    STAFF_TEXTS["staff-search-started"]({
        location: "Dragon Park 2, Львів",
        date: "24 серпня",
        time: "14:00-21:00",
    });

describe("search started text", () => {
    /**
     * Власник запускає пошук за фотографа — зняв зі зміни або домовився
     * голосом. Досі людина дізнавалась про це, побачивши чужого на своїй
     * зміні: усі інші види сповіщень адресовані кандидатам, а не їй.
     */
    it("tells the photographer the shift is being covered for her", () => {
        expect(text()).toMatch(/шука/iu);
    });

    it("names the shift so she knows which one", () => {
        // 13 з 20 локацій ділять назву — без міста та дати не зрозуміти.
        expect(text()).toContain("Dragon Park 2, Львів");
        expect(text()).toContain("24 серпня");
    });

    it("does not ask her to do anything", () => {
        // Це повідомлення, а не запит: рішення вже прийняте власником, і
        // кнопки тут створили б враження, що щось залежить від неї.
        expect(text()).not.toMatch(/натисни|обери|підтвердь/iu);
    });
});

describe("search started delivery", () => {
    it("is a kind the client will accept", () => {
        // Без цього рядок не пройде zod і осяде в invalidPublicIds назавжди.
        expect(client).toContain('"SEARCH_STARTED"');
    });

    it("renders its own branch rather than falling through", () => {
        expect(dispatcher).toContain('case "SEARCH_STARTED"');
        expect(dispatcher).toContain("staff-search-started");
    });

    it("carries no buttons", () => {
        // Клавіатура є лише в OFFER і OPEN_SHIFT_OFFER — там, де людина
        // відповідає. Тут відповідати нема на що.
        const offerKeyboardLine = dispatcher.match(/const offerKeyboard =[\s\S]{0,400}?;/u)?.[0] ?? "";
        expect(offerKeyboardLine).not.toContain("SEARCH_STARTED");
    });
});
