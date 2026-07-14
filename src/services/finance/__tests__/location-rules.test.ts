import { describe, expect, it } from "vitest";
import { getReportableCashAmount, getReportableTerminalAmount, shouldExcludeTerminalFromFopAccounting } from "../location-rules.js";

describe("finance location rules", () => {
    it("excludes Fly Kids Kyiv terminal from FOP accounting", () => {
        const loc = {
            name: "Fly Kids Київ (Дніпровський)",
            legacyName: null,
            city: "Київ",
            sheet: "FK Київ"
        };

        expect(shouldExcludeTerminalFromFopAccounting(loc)).toBe(true);
        expect(getReportableTerminalAmount(1234, loc)).toBe(0);
    });

    it("uses 70 percent of Fly Kids Kyiv cash as the reportable cash base", () => {
        const loc = {
            name: "Fly Kids (Київ)",
            legacyName: "Fly Kids Київ (Дніпровський)",
            city: "Київ",
            sheet: "FK Київ"
        };

        expect(getReportableCashAmount(1000, loc)).toBe(700);
    });

    it("keeps terminal amounts for other Fly Kids locations", () => {
        expect(getReportableTerminalAmount(1234, {
            name: "Fly Kids",
            legacyName: "Fly Kids Рівне",
            city: "Рівне",
            sheet: "FK Рівне"
        })).toBe(1234);

        expect(getReportableTerminalAmount(1234, {
            name: "Fly Kids Львів",
            legacyName: null,
            city: "Львів",
            sheet: "FK Львів"
        })).toBe(1234);
    });

    it("keeps full cash as reportable cash for other Fly Kids locations", () => {
        expect(getReportableCashAmount(1000, {
            name: "Fly Kids",
            legacyName: "Fly Kids Рівне",
            city: "Рівне",
            sheet: "FK Рівне"
        })).toBe(1000);
    });
});
