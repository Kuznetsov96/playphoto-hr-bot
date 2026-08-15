#!/usr/bin/env node
/**
 * check-location-labels.mjs
 *
 * Fails the build when a user-facing string names a location by its raw `name` field instead of
 * going through the shared formatter.
 *
 * Why this exists: the canonical catalogue holds three venues called "Volkland", four called
 * "Smile Park" and three called "Karamel". What tells them apart is `branch`, so a message built
 * from `location.name` alone leaves a photographer unable to tell which venue she is being sent
 * to. That bug was fixed once across ~30 call sites; without a check, the thirty-first arrives
 * with the next feature and nobody notices until someone drives to the wrong venue.
 *
 * The rule is narrow on purpose — it only fires on `.name` interpolated into a template string,
 * which is what reaches a human. Sorting keys, map lookups, log lines and comparisons are
 * untouched, since a raw name is the right thing there.
 *
 * Exits 1 on a violation, like check-menu-ids and check-cycles.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Files exempt from the rule.
 *
 * `location-label.ts` is the formatter itself. `scripts/` are one-off operator tools whose output
 * goes to a terminal, not to a photographer — a raw name is what an operator wants there.
 */
const EXEMPT = [
    "utils/location-label.ts",
    "scripts/",
];

/** The formatter, and the wrappers that delegate to it. Any of these on the line clears it. */
const FORMATTERS = /\bformat(Location|ShiftLocationLabel|LogisticsLocation|StatsLocationName)\b|\bgetShortLocationName\b/;

/**
 * `${...location.name...}` — the raw catalogue field reaching a rendered string.
 *
 * A bare `locationName` variable is not flagged: by the time a value carries that name it has
 * usually been through the formatter already (`const locationName = formatLocation(...)`), and
 * flagging it would train people to rename variables rather than fix labels. What matters is the
 * field access, which is where the branch is lost.
 */
const RAW_NAME_IN_TEMPLATE = /\$\{[^}]*\b(?:location|loc|venue)\??\.name\b[^}]*\}/;

/**
 * Lines where a raw name is correct: it is being used as an identity, not shown to anyone.
 * A map key or a sort comparator wants the stable field, and a formatted label would be wrong.
 */
const NON_RENDERING = /\b(?:Key|key)\s*=|localeCompare|\.sort\(|new Set\(|\.has\(|\.get\(|\.set\(/;

function walkFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === "__tests__" || entry === "node_modules") continue;
            files.push(...walkFiles(full));
            continue;
        }
        if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
    }
    return files;
}

const violations = [];

for (const file of walkFiles(SRC_DIR)) {
    const shown = relative(REPO_DIR, file);
    if (EXEMPT.some((exempt) => shown.includes(exempt))) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (!RAW_NAME_IN_TEMPLATE.test(line)) return;
        if (FORMATTERS.test(line)) return;
        if (NON_RENDERING.test(line)) return;
        violations.push({ file: shown, line: index + 1, code: trimmed.slice(0, 100) });
    });
}

if (violations.length > 0) {
    console.error(`❌ ${violations.length} location label(s) built from a raw name:\n`);
    for (const violation of violations) {
        console.error(`   ${violation.file}:${violation.line}`);
        console.error(`      ${violation.code}\n`);
    }
    console.error("A venue's name alone does not identify it: three venues are called \"Volkland\",");
    console.error("four \"Smile Park\". Use formatLocation(location, context) from utils/location-label.js:\n");
    console.error("   in-city    Fly Kids                 the screen already names the city");
    console.error("   listing    Fly Kids (Lviv)          a picker or report spanning cities");
    console.error("   sentence   Fly Kids, Lviv           prose, notifications, detail headers\n");
    console.error("For a shift row use formatShiftLocationLabel(location); for a parcel,");
    console.error("formatLogisticsLocation(location).\n");
    process.exit(1);
}

console.log("✅ Every location label goes through the formatter.");
