import { describe, expect, it, vi } from "vitest";
import {
    getBankNameByIban,
    getUkrainianIbanMfo,
    isValidUkrainianIban,
    normalizeIban,
    resolveBankNameByIban,
    UKRAINIAN_BANKS_BY_MFO,
} from "../iban-utils.js";

describe("iban-utils", () => {
    it("extracts MFO from Ukrainian IBAN", () => {
        expect(getUkrainianIbanMfo("UA763220010000026208341095838")).toBe("322001");
    });

    it("identifies Monobank / Universal Bank by MFO 322001", () => {
        expect(getBankNameByIban("UA763220010000026208341095838")).toBe("Monobank / Universal Bank (АТ \"Універсал Банк\")");
    });

    it("keeps common bank MFO mappings aligned with current Ukrainian IBAN codes", () => {
        expect(UKRAINIAN_BANKS_BY_MFO["305299"]).toBe("PrivatBank (ПриватБанк)");
        expect(UKRAINIAN_BANKS_BY_MFO["322313"]).toBe("Ukreximbank (Укрексімбанк)");
        expect(UKRAINIAN_BANKS_BY_MFO["339500"]).toBe("Tascombank (ТАСКОМБАНК)");
    });

    it("normalizes user-entered IBAN separators", () => {
        expect(normalizeIban("ua76 3220-0100 0002 6208 3410 9583 8")).toBe("UA763220010000026208341095838");
    });

    it("validates Ukrainian IBAN checksum", () => {
        expect(isValidUkrainianIban("UA763220010000026208341095838")).toBe(true);
        expect(isValidUkrainianIban("UA763220010000026208341095839")).toBe(false);
    });

    it("prefers official NBU bank data when available", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => [{
                MFO: 322001,
                N_GOL: "АТ \"УНІВЕРСАЛ БАНК\"",
                FULLNAME: "АКЦІОНЕРНЕ ТОВАРИСТВО \"УНІВЕРСАЛ БАНК\"",
            }],
        })) as any;

        await expect(resolveBankNameByIban("UA763220010000026208341095838")).resolves.toBe("АТ \"УНІВЕРСАЛ БАНК\"");

        globalThis.fetch = originalFetch;
    });
});
