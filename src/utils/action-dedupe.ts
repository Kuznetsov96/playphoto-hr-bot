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

    /**
     * Снять отметку до истечения окна.
     *
     * Нужно там, где действие ПРОВАЛИЛОСЬ и человеку предлагают повторить: без
     * этого окно проглотило бы осознанный повтор, и кнопка «Зберегти» молча не
     * срабатывала бы несколько секунд после ошибки — ровно тогда, когда её и
     * нажимают.
     */
    release(key: string) {
        this.seen.delete(key);
    }

    private clearExpired(nowMs: number) {
        for (const [key, ts] of this.seen.entries()) {
            if (nowMs - ts >= this.windowMs) {
                this.seen.delete(key);
            }
        }
    }
}
