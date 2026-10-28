import { describe, expect, it } from "vitest";
import { ADMIN_TEXTS } from "../admin-texts.js";

const PREFIXES = ["admin-main-", "admin-sys-", "admin-ops-", "admin-panel-", "support-panel-"];
const EMOJI = /\p{Extended_Pictographic}/u;

describe("admin menu texts follow HIG", () => {
    it("have no emoji in menu titles, buttons and headers", () => {
        const offenders: string[] = [];
        for (const [key, value] of Object.entries(ADMIN_TEXTS)) {
            if (!PREFIXES.some(prefix => key.startsWith(prefix))) continue;
            const text = typeof value === "function"
                ? (value as (p: Record<string, string | number>) => string)(new Proxy({}, { get: () => "x" }))
                : String(value);
            if (EMOJI.test(text)) offenders.push(key);
        }
        expect(offenders).toEqual([]);
    });
});
