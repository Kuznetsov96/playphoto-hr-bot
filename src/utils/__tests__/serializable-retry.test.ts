import { beforeEach, describe, expect, it, vi } from "vitest";

const logBusinessEvent = vi.hoisted(() => vi.fn());
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent }));

import { isTransactionConflict, withSerializableRetry } from "../serializable-retry.js";

const conflict = () => Object.assign(new Error("write conflict with +380671234567"), { code: "P2034" });
const noWait = () => Promise.resolve();

describe("isTransactionConflict", () => {
    it("впізнає P2034 і серіалізаційні коди Postgres у тексті помилки", () => {
        expect(isTransactionConflict(conflict())).toBe(true);
        expect(isTransactionConflict(new Error('Unknown: code: "40P01", deadlock detected'))).toBe(true);
        expect(isTransactionConflict(new Error('Unknown: code: "40001"'))).toBe(true);
    });

    it("не плутає конфлікт з іншими помилками", () => {
        expect(isTransactionConflict(new Error("Unique constraint"))).toBe(false);
        expect(isTransactionConflict(Object.assign(new Error("x"), { code: "P2002" }))).toBe(false);
        expect(isTransactionConflict(new Error("order 40001 not found"))).toBe(false);
        expect(isTransactionConflict(null)).toBe(false);
    });
});

describe("withSerializableRetry", () => {
    beforeEach(() => logBusinessEvent.mockReset());

    it("повертає результат після конфлікту й повторює саме транзакцію", async () => {
        const run = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValue("ok");
        await expect(withSerializableRetry("op", run, { sleep: noWait })).resolves.toBe("ok");
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("після трьох повторів віддає початкову помилку", async () => {
        const error = conflict();
        const run = vi.fn().mockRejectedValue(error);
        await expect(withSerializableRetry("op", run, { sleep: noWait })).rejects.toBe(error);
        expect(run).toHaveBeenCalledTimes(4);
    });

    it("не повторює інші помилки", async () => {
        const error = new Error("Unique constraint");
        const run = vi.fn().mockRejectedValue(error);
        await expect(withSerializableRetry("op", run, { sleep: noWait })).rejects.toBe(error);
        expect(run).toHaveBeenCalledTimes(1);
        expect(logBusinessEvent).not.toHaveBeenCalled();
    });

    it("чекає з експоненційною стелею і випадковим розкидом", async () => {
        const sleep = vi.fn((_ms: number) => Promise.resolve());
        const run = vi.fn().mockRejectedValue(conflict());
        await withSerializableRetry("op", run, { sleep, random: () => 1 }).catch(() => undefined);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([200, 400, 800]);

        sleep.mockClear();
        await withSerializableRetry("op", run, { sleep, random: () => 0 }).catch(() => undefined);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([0, 0, 0]);
    });

    it("у лог іде лише операція й номер спроби, без тексту помилки", async () => {
        const run = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValue("ok");
        await withSerializableRetry("op", run, { sleep: noWait });
        expect(logBusinessEvent).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(logBusinessEvent.mock.calls[0]);
        expect(logged).toContain('"attempt":1');
        expect(logged).not.toContain("380671234567");
    });
});
