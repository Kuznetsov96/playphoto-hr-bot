import { describe, expect, it, vi } from "vitest";
import { backfillReplacementScheduledShiftIds } from "../replacement-canonical-backfill.js";

/*
 * Примітка щодо шляху імпорту: бриф задачі показував тест, що імпортує
 * скрипт напряму з `../../../scripts/...`. Такий шлях не резолвиться під
 * контролем tsc — tsconfig.json явно виключає `src/scripts` і обмежує
 * `include` до `src/**\/*`, тож `scripts/` узагалі поза перевіреним деревом.
 * Жоден існуючий скрипт у `scripts/` так само не має юніт-теста, що
 * імпортував би його напряму. Тому чиста функція лежить тут, у
 * `src/services/`, як і решта подібної логіки (`canonical-shift-resolver.ts`,
 * `replacement-canonical.ts`), а `scripts/backfill-replacement-scheduled-shift.ts`
 * лишається тонкою обгорткою запуску з реальним prisma.
 */

describe("backfillReplacementScheduledShiftIds", () => {
    it("заповнює канонічний id там, де дзеркало знає пару", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "req-1", workShiftId: "shift-1" },
                    { id: "req-2", workShiftId: "shift-2" },
                ]),
                update,
            },
            workShift: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "shift-1", awsScheduledShiftPublicId: "canon-1" },
                    { id: "shift-2", awsScheduledShiftPublicId: "canon-2" },
                ]),
            },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 2, filled: 2, unmatched: 0 });
        expect(update).toHaveBeenCalledWith({
            where: { id: "req-1" },
            data: { scheduledShiftPublicId: "canon-1" },
        });
    });

    it("рахує заявки без пари, а не мовчить про них", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "req-1", workShiftId: "shift-1" },
                    { id: "req-2", workShiftId: "shift-missing" },
                ]),
                update,
            },
            workShift: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "shift-1", awsScheduledShiftPublicId: "canon-1" },
                    { id: "shift-missing", awsScheduledShiftPublicId: null },
                ]),
            },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 2, filled: 1, unmatched: 1 });
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("нічого не робить, коли заповнювати нема чого", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: { findMany: vi.fn().mockResolvedValue([]), update },
            workShift: { findMany: vi.fn() },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 0, filled: 0, unmatched: 0 });
        expect(update).not.toHaveBeenCalled();
        expect(db.workShift.findMany).not.toHaveBeenCalled();
    });
});
