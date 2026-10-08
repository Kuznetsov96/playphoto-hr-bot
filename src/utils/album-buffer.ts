import logger from "../core/logger.js";

/**
 * Альбом приходить окремими оновленнями з одним media_group_id. Буфер збирає їх,
 * поки йдуть нові частини, і віддає разом — щоб альбом лишився альбомом, а не
 * трьома окремими фото (spec 2026-10-08). Живе в пам'яті процесу: альбом,
 * що прийшов під час рестарту, піде частинами — це прийнятна втрата.
 */
export class AlbumBuffer<T> {
    private readonly pending = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout>; done: Promise<void>; release: () => void }>();

    /** true — це перша частина альбому. */
    add(key: string, item: T, flush: (items: T[]) => Promise<void>, delayMs = 1000): boolean {
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing.timer);
        const items = existing ? [...existing.items, item] : [item];
        let release = existing?.release ?? (() => undefined);
        const done = existing?.done ?? new Promise<void>(resolve => { release = resolve; });
        const timer = setTimeout(() => {
            flush(items)
                .catch(error => logger.error({ err: error, key }, "Album flush failed"))
                .finally(() => {
                    this.pending.delete(key);
                    release();
                });
        }, delayMs);
        this.pending.set(key, { items, timer, done, release });
        return !existing;
    }

    /**
     * Дочекатися альбомів із ключем на цей префікс (чат): текст, надісланий одразу
     * після альбому, має лягти в тему після нього, а не перед.
     */
    async whenIdle(prefix: string): Promise<void> {
        const waiting = [...this.pending.entries()].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => entry.done);
        await Promise.all(waiting);
    }
}
