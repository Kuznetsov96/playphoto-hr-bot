import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
    fileURLToPath(new URL("../replacement-service.ts", import.meta.url)),
    "utf8"
);

describe("replacement-service shadow wiring", () => {
    it("imports the replacement shadow service", () => {
        expect(source).toContain('from "./replacement-shadow.js"');
    });

    it("hands the legacy candidate set to the shadow comparison", () => {
        expect(source).toContain("replacementShadowService.compareInBackground");
        expect(source).toContain("legacyCandidates");
    });

    it("hands the wave being searched to the shadow comparison", () => {
        // Without this, the shadow compare cannot tell which canonical wave to
        // compare against and ends up flattening every wave, comparing
        // mismatched populations.
        expect(source).toMatch(/compareInBackground\(\{[\s\S]*?wave,?[\s\S]*?\}\)/u);
    });

    it("does not await the shadow comparison in the user path", () => {
        expect(source).not.toMatch(/await\s+replacementShadowService\.compareInBackground/u);
    });
});
