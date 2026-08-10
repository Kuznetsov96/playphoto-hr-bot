import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../preferences-flow.ts", import.meta.url)),
    "utf8"
);

describe("preferences flow canonical write", () => {
    it("routes the save through the canonical writer behind the flag", () => {
        expect(source).toContain("AWS_PREFERENCES_CANONICAL_WRITE_ENABLED");
        expect(source).toContain("saveCanonicalPreference");
    });

    it("keeps the Google Sheet write only as the rollback path", () => {
        expect(source).toContain("preferencesService.savePreference");
    });

    it("never performs both writes in the same branch", () => {
        expect(source).not.toMatch(
            /saveCanonicalPreference[\s\S]{0,400}?await\s+preferencesService\.savePreference/u
        );
    });
});
