import { describe, expect, it } from "vitest";
import { getReportableTerminalAmount, shouldExcludeTerminalFromFopAccounting } from "../location-rules.js";

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
});
