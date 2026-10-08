import logger from "../core/logger.js";

type Entry<T> = {
    key: string;
    items: T[];
    timer: ReturnType<typeof setTimeout>;
    done: Promise<void>;
    release: () => void;
};

/**
 * Альбом приходить окремими оновленнями з одним media_group_id. Буфер збирає їх,
 * поки йдуть нові частини, і віддає разом — щоб альбом лишився альбомом, а не
 * трьома окремими фото (spec 2026-10-08). Живе в пам'яті процесу: альбом,
 * що прийшов під час рестарту, піде частинами — це прийнятна втрата.
 *
 * Партія виходить із черги в момент відправки: частина, що прийшла, поки
 * попередні ще летять, починає нову партію, а не відправляє їх удруге.
 */
export class AlbumBuffer<T> {
    private readonly pending = new Map<string, Entry<T>>();
    private readonly flushing = new Set<Entry<T>>();

    /** true — це перша частина партії. */
    add(key: string, item: T, flush: (items: T[]) => Promise<void>, delayMs = 1000): boolean {
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing.timer);

        let release: () => void = () => undefined;
        const entry: Entry<T> = existing ?? {
            key,
            items: [],
            timer: undefined as unknown as ReturnType<typeof setTimeout>,
            done: new Promise<void>(resolve => { release = resolve; }),
            release: () => release(),
        };
        entry.items = [...entry.items, item];
        entry.timer = setTimeout(() => {
            this.pending.delete(key);
            this.flushing.add(entry);
            flush(entry.items)
                .catch(error => logger.error({ err: error, key }, "Album flush failed"))
                .finally(() => {
                    this.flushing.delete(entry);
                    entry.release();
                });
        }, delayMs);
        this.pending.set(key, entry);
        return !existing;
    }

    /**
     * Дочекатися партій із ключем на цей префікс (чат) — і тих, що в черзі, і тих, що
     * вже відправляються: текст одразу після альбому має лягти в тему після нього.
     */
    async whenIdle(prefix: string): Promise<void> {
        const waiting = [...this.pending.values(), ...this.flushing]
            .filter(entry => entry.key.startsWith(prefix))
            .map(entry => entry.done);
        await Promise.all(waiting);
    }
}
