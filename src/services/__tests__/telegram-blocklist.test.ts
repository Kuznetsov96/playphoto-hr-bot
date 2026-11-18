import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const deleteMany = vi.fn();
const createMany = vi.fn();
const transaction = vi.fn();
const error = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        blockedTelegramId: { findMany },
        $transaction: transaction,
    },
}));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
}));

let telegramBlocklist: (typeof import("../telegram-blocklist.js"))["telegramBlocklist"];

const tx = { blockedTelegramId: { deleteMany, createMany } };

describe("telegramBlocklist", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
        deleteMany.mockResolvedValue({ count: 0 });
        createMany.mockResolvedValue({ count: 0 });
        vi.resetModules();
        ({ telegramBlocklist } = await import("../telegram-blocklist.js"));
    });

    it("is empty and not loaded before ensureLoaded", () => {
        expect(telegramBlocklist.has(5560739103)).toBe(false);
        expect(telegramBlocklist.isLoaded()).toBe(false);
    });

    it("loads rows into the set", async () => {
        findMany.mockResolvedValueOnce([{ telegramId: 5560739103n }]);
        await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(true);
        expect(telegramBlocklist.isLoaded()).toBe(true);
        expect(telegramBlocklist.has(5560739103)).toBe(true);
        expect(telegramBlocklist.has(1n)).toBe(false);
    });

    it("does not hit the database again after a successful load", async () => {
        findMany.mockResolvedValueOnce([]);
        await telegramBlocklist.ensureLoaded();
        await telegramBlocklist.ensureLoaded();
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("returns false and retries after the backoff when the read fails", async () => {
        vi.useFakeTimers();
        try {
            findMany.mockRejectedValueOnce(new Error("db down"));
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(false);
            expect(telegramBlocklist.isLoaded()).toBe(false);
            expect(error).toHaveBeenCalled();
            vi.advanceTimersByTime(5_000);
            findMany.mockResolvedValueOnce([{ telegramId: 7n }]);
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(true);
            expect(findMany).toHaveBeenCalledTimes(2);
            expect(telegramBlocklist.has(7)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not query again within 5s after a failure, queries after 5s", async () => {
        vi.useFakeTimers();
        try {
            findMany.mockRejectedValue(new Error("db down"));
            await telegramBlocklist.ensureLoaded();
            vi.advanceTimersByTime(4_999);
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(false);
            expect(findMany).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1);
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(false);
            expect(findMany).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("shares one query between parallel ensureLoaded calls", async () => {
        findMany.mockResolvedValueOnce([{ telegramId: 3n }]);
        const results = await Promise.all(Array.from({ length: 10 }, () => telegramBlocklist.ensureLoaded()));
        expect(results.every(Boolean)).toBe(true);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(telegramBlocklist.has(3n)).toBe(true);
    });

    it("a replaceAll committed during the first read wins over the stale rows", async () => {
        let release!: (rows: { telegramId: bigint }[]) => void;
        findMany.mockReturnValueOnce(new Promise(resolve => (release = resolve)));
        const pending = telegramBlocklist.ensureLoaded();
        await telegramBlocklist.replaceAll([2n]);
        release([{ telegramId: 1n }]);
        await expect(pending).resolves.toBe(true);
        expect(telegramBlocklist.has(2n)).toBe(true);
        expect(telegramBlocklist.has(1n)).toBe(false);
    });

    it("keeps ids above 2^53 exact", async () => {
        await telegramBlocklist.replaceAll([9007199254740993n]);
        expect(telegramBlocklist.has(9007199254740993n)).toBe(true);
        expect(telegramBlocklist.has(9007199254740992n)).toBe(false);
    });

    it("replaceAll writes in one transaction and reports sizes", async () => {
        await telegramBlocklist.replaceAll([1n]);
        const result = await telegramBlocklist.replaceAll([2n, 3n]);
        expect(result).toEqual({ before: 1, after: 2 });
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(deleteMany).toHaveBeenLastCalledWith({});
        expect(createMany).toHaveBeenLastCalledWith({
            data: [{ telegramId: 2n }, { telegramId: 3n }],
            skipDuplicates: true,
        });
    });

    it("replaceAll with an empty list clears the set and marks it loaded", async () => {
        await telegramBlocklist.replaceAll([5n]);
        await telegramBlocklist.replaceAll([]);
        expect(telegramBlocklist.has(5n)).toBe(false);
        expect(telegramBlocklist.isLoaded()).toBe(true);
    });

    it("keeps the previous set when the transaction fails", async () => {
        await telegramBlocklist.replaceAll([5n]);
        transaction.mockRejectedValueOnce(new Error("tx failed"));
        await expect(telegramBlocklist.replaceAll([6n])).rejects.toThrow("tx failed");
        expect(telegramBlocklist.has(5n)).toBe(true);
        expect(telegramBlocklist.has(6n)).toBe(false);
    });

    it("a synchronous findMany throw does not leave a settled promise in flight", async () => {
        vi.useFakeTimers();
        try {
            findMany.mockImplementationOnce(() => {
                throw new Error("sync boom");
            });
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(false);
            expect(findMany).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(5_000);
            findMany.mockResolvedValueOnce([{ telegramId: 7n }]);
            await expect(telegramBlocklist.ensureLoaded()).resolves.toBe(true);
            expect(findMany).toHaveBeenCalledTimes(2);
            expect(telegramBlocklist.has(7n)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
