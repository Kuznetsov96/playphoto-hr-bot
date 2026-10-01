import { describe, expect, it } from "vitest";
import {
    buildShiftPickerView,
    SHIFT_PICKER_VISIBLE_LIMIT
} from "../replacement-shift-picker-view.js";

const shifts = (count: number) => Array.from({ length: count }, (_, index) => `shift-${index}`);

describe("buildShiftPickerView", () => {
    it("показує всі зміни, коли їх небагато, і нічого не дописує", () => {
        const view = buildShiftPickerView(shifts(13));

        expect(view.visible).toHaveLength(13);
        expect(view.hiddenCount).toBe(0);
        expect(view.text).toBe("Обери дату і локацію.");
    });

    it("показує рівно стелю без згадки про зріз, коли схована жодна", () => {
        const view = buildShiftPickerView(shifts(SHIFT_PICKER_VISIBLE_LIMIT));

        expect(view.visible).toHaveLength(SHIFT_PICKER_VISIBLE_LIMIT);
        expect(view.hiddenCount).toBe(0);
        expect(view.text).toBe("Обери дату і локацію.");
    });

    it("ніколи не ріже мовчки: називає, скільки показано з якої кількості", () => {
        const view = buildShiftPickerView(shifts(25));

        expect(view.visible).toHaveLength(SHIFT_PICKER_VISIBLE_LIMIT);
        expect(view.hiddenCount).toBe(5);
        expect(view.text).toContain("20 змін з 25");
    });
});

describe("заблокована зміна в пікері", () => {
    it("лишається на екрані з поміткою, а не зникає", async () => {
        const { pickerBlockedMark } = await import("../replacement-shift-picker-view.js");

        expect(pickerBlockedMark("ACTIVE")).toBe("🔎 пошук триває");
        expect(pickerBlockedMark("FOUND")).toBe("✅ підміну знайдено");
        expect(pickerBlockedMark("FAILED")).toBe("✖️ не знайшли");
    });

    it("на дотик називає конкретну причину для кожного стану заявки", async () => {
        const { replacementBlockedReason } = await import("../replacement-shift-picker-view.js");

        // 01.10.2026: фотографиня бачила «немає майбутніх змін», хоча зміни
        // були — пікер мовчки ховав ті, по яких пошук уже йшов або не вдався.
        expect(replacementBlockedReason("ACTIVE")).toContain("вже триває");
        expect(replacementBlockedReason("FOUND")).toContain("вже знайдено");
        expect(replacementBlockedReason("FAILED")).toContain("не знайшли");
        // Telegram ріже текст спливного вікна на 200 знаках.
        for (const status of ["ACTIVE", "FOUND", "FAILED"] as const) {
            expect(replacementBlockedReason(status).length).toBeLessThanOrEqual(200);
        }
    });
});
