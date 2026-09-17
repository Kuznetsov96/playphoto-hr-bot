import { describe, expect, it } from "vitest";
import { isValidTaskDeadlineTime } from "../task-time.js";

/**
 * Divergence B з аудиту вирівнювання майстрів постановки задач:
 * task-creation.ts і task-flow.ts раніше приймали "99:99" і "5:77" як
 * валідний час (`/^\d{1,2}:\d{2}$/`), тоді як task-bulk.ts вже мав
 * правильний регекс. Тепер усі три використовують цю функцію.
 */
describe("isValidTaskDeadlineTime", () => {
    it("rejects hours or minutes out of range", () => {
        expect(isValidTaskDeadlineTime("99:99")).toBe(false);
        expect(isValidTaskDeadlineTime("5:77")).toBe(false);
        expect(isValidTaskDeadlineTime("24:00")).toBe(false);
    });

    it("accepts valid single- and double-digit times", () => {
        expect(isValidTaskDeadlineTime("9:05")).toBe(true);
        expect(isValidTaskDeadlineTime("23:59")).toBe(true);
    });

    it("rejects garbage input", () => {
        expect(isValidTaskDeadlineTime("")).toBe(false);
        expect(isValidTaskDeadlineTime("noon")).toBe(false);
        expect(isValidTaskDeadlineTime("12:5")).toBe(false);
        expect(isValidTaskDeadlineTime("12:00 ")).toBe(false);
    });
});
