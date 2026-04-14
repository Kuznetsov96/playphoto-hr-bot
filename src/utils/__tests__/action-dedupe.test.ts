import { describe, expect, it } from "vitest";

import { ActionDedupeWindow } from "../action-dedupe.js";

describe("ActionDedupeWindow", () => {
    it("blocks repeated acquisition inside the debounce window", () => {
        const dedupe = new ActionDedupeWindow(1000);

        expect(dedupe.tryAcquire("same", 1000)).toBe(true);
        expect(dedupe.tryAcquire("same", 1500)).toBe(false);
    });

    it("allows acquisition after the debounce window expires", () => {
        const dedupe = new ActionDedupeWindow(1000);

        expect(dedupe.tryAcquire("same", 1000)).toBe(true);
        expect(dedupe.tryAcquire("same", 2001)).toBe(true);
    });

    it("keeps different keys independent", () => {
        const dedupe = new ActionDedupeWindow(1000);

        expect(dedupe.tryAcquire("a", 1000)).toBe(true);
        expect(dedupe.tryAcquire("b", 1000)).toBe(true);
    });
});
