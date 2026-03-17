#!/usr/bin/env node
/**
 * check-menu-ids.mjs
 * Scans src/ for duplicate Menu IDs (new Menu("some-id")).
 * Exits with code 1 if duplicates found — used in CI to block broken deploys.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;

function walkFiles(dir) {
    const entries = readdirSync(dir);
    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            files.push(...walkFiles(full));
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            files.push(full);
        }
    }
    return files;
}

const MENU_PATTERN = /new\s+Menu\s*<[^>]*>\s*\(\s*["']([^"']+)["']\s*\)/g;

const idMap = {}; // id -> [file, file, ...]

for (const file of walkFiles(SRC_DIR)) {
    const content = readFileSync(file, "utf8");
    let match;
    while ((match = MENU_PATTERN.exec(content)) !== null) {
        const id = match[1];
        if (!idMap[id]) idMap[id] = [];
        idMap[id].push(file.replace(SRC_DIR, "src"));
    }
}

const duplicates = Object.entries(idMap).filter(([, files]) => files.length > 1);

if (duplicates.length === 0) {
    console.log("✅ No duplicate Menu IDs found.");
    process.exit(0);
} else {
    console.error("❌ DUPLICATE MENU IDs DETECTED:\n");
    for (const [id, files] of duplicates) {
        console.error(`  Menu ID: "${id}"`);
        for (const f of files) console.error(`    → ${f}`);
    }
    console.error(
        "\nThis will cause 'Menu already registered!' crash on bot start."
    );
    console.error("Fix: each Menu ID must be unique across the entire codebase.");
    process.exit(1);
}
