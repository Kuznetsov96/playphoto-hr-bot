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
        expect(view.text).toBe("Оберіть дату і локацію.");
    });

    it("показує рівно стелю без згадки про зріз, коли схована жодна", () => {
        const view = buildShiftPickerView(shifts(SHIFT_PICKER_VISIBLE_LIMIT));

        expect(view.visible).toHaveLength(SHIFT_PICKER_VISIBLE_LIMIT);
        expect(view.hiddenCount).toBe(0);
        expect(view.text).toBe("Оберіть дату і локацію.");
    });

    it("ніколи не ріже мовчки: називає, скільки показано з якої кількості", () => {
        const view = buildShiftPickerView(shifts(25));

        expect(view.visible).toHaveLength(SHIFT_PICKER_VISIBLE_LIMIT);
        expect(view.hiddenCount).toBe(5);
        expect(view.text).toContain("20 змін з 25");
    });
});
