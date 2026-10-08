import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumBuffer } from "../album-buffer.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("буфер альбому", () => {
    it("збирає частини одного альбому в один виклик", async () => {
        const buffer = new AlbumBuffer<number>();
        const flush = vi.fn(async () => undefined);
        buffer.add("chat:1", 3, flush, 1000);
        buffer.add("chat:1", 1, flush, 1000);
        buffer.add("chat:1", 2, flush, 1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith([3, 1, 2]);
    });

    it("кожна нова частина відкладає відправку", async () => {
        const buffer = new AlbumBuffer<number>();
        const flush = vi.fn(async () => undefined);
        buffer.add("a", 1, flush, 1000);
        await vi.advanceTimersByTimeAsync(800);
        buffer.add("a", 2, flush, 1000);
        await vi.advanceTimersByTimeAsync(800);
        expect(flush).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(flush).toHaveBeenCalledWith([1, 2]);
    });

    it("різні альбоми не змішуються", async () => {
        const buffer = new AlbumBuffer<number>();
        const flush = vi.fn(async () => undefined);
        buffer.add("a", 1, flush, 1000);
        buffer.add("b", 2, flush, 1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(flush).toHaveBeenCalledTimes(2);
    });

    it("перша частина каже, що вона перша", () => {
        const buffer = new AlbumBuffer<number>();
        expect(buffer.add("a", 1, async () => undefined)).toBe(true);
        expect(buffer.add("a", 2, async () => undefined)).toBe(false);
    });

    it("помилка відправки не валить процес", async () => {
        const buffer = new AlbumBuffer<number>();
        buffer.add("a", 1, async () => { throw new Error("boom"); }, 10);
        await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
    });
});
