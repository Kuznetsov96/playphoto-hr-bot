#!/usr/bin/env node
/**
 * check-cycles.mjs
 * Detects circular imports using madge.
 *
 * Strategy: "Threshold" mode.
 *   - We record the current known baseline (KNOWN_CYCLE_COUNT).
 *   - CI fails if the number of circular chains EXCEEDS the baseline.
 *   - This lets us gradually fix old cycles without blocking development.
 *   - If you intentionally reduce cycles, lower KNOWN_CYCLE_COUNT accordingly.
 *
 * HOW TO UPDATE BASELINE:
 *   Run `npm run check-cycles` locally, check the count, update KNOWN_CYCLE_COUNT.
 */

import madge from "madge";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "../src");

// ⬇️  Current known baseline — increase only to unblock, decrease as you fix.
const KNOWN_CYCLE_COUNT = 0;

const result = await madge(SRC_DIR, {
    fileExtensions: ["ts"],
    detectiveOptions: { ts: { mixedImports: true } },
});

const cycles = result.circular();
const count = cycles.length;

if (count === 0) {
    console.log("✅ No circular dependencies found!");
    process.exit(0);
}

console.log(`ℹ️  Found ${count} circular dependency chain(s):\n`);
cycles.forEach((chain, i) => {
    console.log(`  ${i + 1}) ${chain.join(" > ")}`);
});

if (count > KNOWN_CYCLE_COUNT) {
    console.error(
        `\n❌ REGRESSION: ${count} cycles found, but baseline is ${KNOWN_CYCLE_COUNT}.`
    );
    console.error(
        `   You introduced ${count - KNOWN_CYCLE_COUNT} NEW circular dependency(ies).`
    );
    console.error(`   Fix them, or update KNOWN_CYCLE_COUNT in scripts/check-cycles.mjs`);
    console.error(`   only if they are intentionally acceptable (e.g. lazy-loaded).`);
    process.exit(1);
} else {
    console.log(
        `\n⚠️  ${count} cycle(s) present — within allowed baseline of ${KNOWN_CYCLE_COUNT}.`
    );
    console.log(`   Consider fixing them to improve startup reliability.`);
    process.exit(0);
}
