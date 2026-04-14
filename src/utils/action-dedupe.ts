export class ActionDedupeWindow {
    private readonly seen = new Map<string, number>();

    constructor(private readonly windowMs: number) { }

    tryAcquire(key: string, nowMs: number = Date.now()) {
        this.clearExpired(nowMs);

        const previous = this.seen.get(key);
        if (previous !== undefined && nowMs - previous < this.windowMs) {
            return false;
        }

        this.seen.set(key, nowMs);
        return true;
    }

    private clearExpired(nowMs: number) {
        for (const [key, ts] of this.seen.entries()) {
            if (nowMs - ts >= this.windowMs) {
                this.seen.delete(key);
            }
        }
    }
}
