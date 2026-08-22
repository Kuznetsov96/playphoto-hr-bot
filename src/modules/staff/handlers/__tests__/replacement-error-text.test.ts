import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAFF_TEXTS } from "../../../../constants/staff-texts.js";

const source = readFileSync(fileURLToPath(new URL("../menu.ts", import.meta.url)), "utf8");

describe("replacement failure messages", () => {
    /**
     * Діана побачила «Не вдалося створити запит… Спробуй ще раз», хоча
     * бекенд відповів 409: заявка вже відкрита. Повтор упреться в той
     * самий конфлікт — у логах видно два натискання поспіль.
     */
    it("routes an already-open request to its own message", () => {
        expect(source).toContain(
            'error?.message === "CANONICAL_REPLACEMENT_FAILED:REPLACEMENT_REQUEST_ALREADY_OPEN"'
        );
        expect(source).toContain('STAFF_TEXTS["staff-replacement-already-open"]');
    });

    it("checks the specific code before the generic prefix", () => {
        // Загальна гілка ловить будь-який CANONICAL_REPLACEMENT_FAILED:*,
        // тож поставлена першою — вона проковтне конкретний код.
        const specific = source.indexOf("staff-replacement-already-open");
        const generic = source.indexOf("staff-replacement-canonical-failed");
        expect(specific).toBeGreaterThan(-1);
        expect(specific).toBeLessThan(generic);
    });

    it("does not tell the photographer to retry what cannot succeed", () => {
        expect(STAFF_TEXTS["staff-replacement-already-open"]).not.toContain("Спробуй ще раз");
    });

    it("keeps the retry advice where a retry can actually help", () => {
        expect(STAFF_TEXTS["staff-replacement-canonical-failed"]).toContain("Спробуй ще раз");
    });
});
