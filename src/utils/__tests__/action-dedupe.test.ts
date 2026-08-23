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

/**
 * The window exists to swallow a double tap WHILE the action runs, not to block a deliberate
 * retry after it failed. Without release, the "try again" button offered after a failed save
 * would silently do nothing for the rest of the window — exactly when people press it.
 */
describe("ActionDedupeWindow.release", () => {
    it("lets the same key through again immediately", () => {
        const window = new ActionDedupeWindow(10_000);
        expect(window.tryAcquire("k", 1_000)).toBe(true);
        expect(window.tryAcquire("k", 1_100)).toBe(false);

        window.release("k");

        expect(window.tryAcquire("k", 1_200)).toBe(true);
    });

    it("leaves other keys alone", () => {
        const window = new ActionDedupeWindow(10_000);
        window.tryAcquire("a", 1_000);
        window.tryAcquire("b", 1_000);

        window.release("a");

        expect(window.tryAcquire("a", 1_100)).toBe(true);
        expect(window.tryAcquire("b", 1_100)).toBe(false);
    });

    it("is harmless for a key that was never acquired", () => {
        const window = new ActionDedupeWindow(10_000);
        expect(() => window.release("missing")).not.toThrow();
    });
});
