import { afterEach, describe, expect, it, vi } from "vitest";

import { TtlCache } from "../ttl-cache.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("TtlCache", () => {
    it("calls the loader once for repeated reads within the TTL", async () => {
        const cache = new TtlCache<number>(1000);
        const loader = vi.fn(async () => 42);

        expect(await cache.get("k", loader)).toBe(42);
        expect(await cache.get("k", loader)).toBe(42);
        expect(await cache.get("k", loader)).toBe(42);

        // Це і є суть: меню перебудовується на кожен тап, але база читається раз.
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it("keeps separate entries per key", async () => {
        const cache = new TtlCache<string>(1000);

        expect(await cache.get("Київ", async () => "a")).toBe("a");
        expect(await cache.get("Львів", async () => "b")).toBe("b");
        expect(await cache.get("Київ", async () => "changed")).toBe("a");
    });

    it("reloads after the TTL expires", async () => {
        vi.useFakeTimers();
        const cache = new TtlCache<number>(1000);
        const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        expect(await cache.get("k", loader)).toBe(1);
        vi.advanceTimersByTime(1001);
        expect(await cache.get("k", loader)).toBe(2);
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it("clear() drops entries so an edited directory shows up at once", async () => {
        const cache = new TtlCache<number>(10_000);
        const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        expect(await cache.get("k", loader)).toBe(1);
        cache.clear();
        expect(await cache.get("k", loader)).toBe(2);
    });

    it("does not cache a failed load", async () => {
        const cache = new TtlCache<number>(10_000);
        const loader = vi.fn()
            .mockRejectedValueOnce(new Error("db down"))
            .mockResolvedValueOnce(7);

        await expect(cache.get("k", loader)).rejects.toThrow("db down");
        // Одна невдала відповідь бази не повинна віддаватися всім наступним
        // викликам до кінця TTL.
        expect(await cache.get("k", loader)).toBe(7);
    });
});
