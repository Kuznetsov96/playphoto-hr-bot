import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../concurrency.js";

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
    it("preserves input order even when later workers resolve faster than earlier ones", async () => {
        const items = [1, 2, 3, 4, 5];
        // Earlier items take longer, so if results were appended in
        // completion order instead of input order this would fail.
        const results = await mapWithConcurrency(items, 3, async item => {
            await delay((items.length - item) * 10);
            return item * 10;
        });

        expect(results).toEqual([10, 20, 30, 40, 50]);
    });

    it("never runs more than `limit` workers concurrently", async () => {
        const items = Array.from({ length: 20 }, (_, index) => index);
        const limit = 4;
        let inFlight = 0;
        let maxObservedInFlight = 0;

        await mapWithConcurrency(items, limit, async item => {
            inFlight += 1;
            maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
            await delay(5);
            inFlight -= 1;
            return item;
        });

        expect(maxObservedInFlight).toBeLessThanOrEqual(limit);
        // Confirms the cap is real, not incidental: with 20 items and no
        // limiting, all 20 would start immediately and this would be 20.
        expect(maxObservedInFlight).toBe(limit);
    });

    it("rejects the overall call when a worker rejects, like Promise.all", async () => {
        const items = [1, 2, 3, 4, 5];
        const failure = new Error("worker failed");

        await expect(
            mapWithConcurrency(items, 2, async item => {
                if (item === 3) throw failure;
                await delay(5);
                return item;
            })
        ).rejects.toThrow(failure);
    });

    it("returns an empty array for empty input", async () => {
        const worker = async (item: number) => item;
        const results = await mapWithConcurrency([], 5, worker);

        expect(results).toEqual([]);
    });

    it("works when the limit exceeds the item count", async () => {
        const items = [1, 2, 3];
        const results = await mapWithConcurrency(items, 100, async item => item * 2);

        expect(results).toEqual([2, 4, 6]);
    });

    it("works with a limit of 1, running strictly sequentially", async () => {
        const items = [1, 2, 3];
        const order: number[] = [];

        const results = await mapWithConcurrency(items, 1, async item => {
            order.push(item);
            await delay(5);
            return item * 2;
        });

        expect(order).toEqual([1, 2, 3]);
        expect(results).toEqual([2, 4, 6]);
    });
});
