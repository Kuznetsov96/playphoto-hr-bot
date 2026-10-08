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

    it("частина, що прийшла під час відправки, не відправляє попередні вдруге", async () => {
        const buffer = new AlbumBuffer<number>();
        const sent: number[][] = [];
        let finishFirst: () => void = () => undefined;
        const flush = vi.fn(async (items: number[]) => {
            sent.push(items);
            if (sent.length === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
        });
        buffer.add("a", 1, flush, 10);
        await vi.advanceTimersByTimeAsync(10);
        buffer.add("a", 2, flush, 10);
        let idle = false;
        const waiting = buffer.whenIdle("a").then(() => { idle = true; });
        await vi.advanceTimersByTimeAsync(10);
        expect(sent).toEqual([[1], [2]]);
        expect(idle).toBe(false);
        finishFirst();
        await waiting;
        expect(idle).toBe(true);
    });

    it("whenIdle чекає і відправку, що вже йде", async () => {
        const buffer = new AlbumBuffer<number>();
        let finish: () => void = () => undefined;
        buffer.add("a", 1, () => new Promise<void>(resolve => { finish = resolve; }), 10);
        await vi.advanceTimersByTimeAsync(10);
        let idle = false;
        const waiting = buffer.whenIdle("a").then(() => { idle = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(idle).toBe(false);
        finish();
        await waiting;
        expect(idle).toBe(true);
    });

    it("помилка відправки не валить процес", async () => {
        const buffer = new AlbumBuffer<number>();
        buffer.add("a", 1, async () => { throw new Error("boom"); }, 10);
        await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
    });
});
