/**
 * Runs `worker` over `items` with at most `limit` invocations in flight at
 * once. Results are returned in the same order as `items`, exactly like
 * `Promise.all`. If any worker rejects, the returned promise rejects with
 * that error (first rejection wins), matching `Promise.all` semantics so
 * callers relying on try/catch fallback behaviour keep working unchanged.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return [];
    if (limit < 1) throw new Error("mapWithConcurrency: limit must be at least 1");

    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function runWorker(): Promise<void> {
        while (true) {
            const currentIndex = nextIndex;
            if (currentIndex >= items.length) return;
            nextIndex += 1;

            const item = items[currentIndex] as T;
            results[currentIndex] = await worker(item);
        }
    }

    const workerCount = Math.min(limit, items.length);
    const runners = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(runners);

    return results;
}
