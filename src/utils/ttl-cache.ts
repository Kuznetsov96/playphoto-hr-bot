/**
 * Найпростіший кеш у пам'яті процесу з часом життя запису.
 *
 * Потрібен динамічним меню кандидатки: плагін @grammyjs/menu перебудовує
 * клавіатуру не лише при рендері, а й при кожному натисканні — щоб знайти,
 * якій кнопці належить обробник. Тобто список міст читався з бази двічі за
 * один тап, а множинний вибір локацій — по разу на кожну галочку.
 *
 * Локації — довідник, який змінюється раз на тиждень, тож секунди
 * застарілості нічим не загрожують: у найгіршому випадку нова локація
 * з'явиться у списку на хвилину пізніше.
 */
type Entry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
    private readonly store = new Map<string, Entry<T>>();

    constructor(private readonly ttlMs: number) {}

    /**
     * Повертає значення з кешу або обчислює його через loader.
     *
     * Помилка loader-а не кешується: інакше одна невдала відповідь бази
     * віддавалася б усім наступним викликам до кінця TTL.
     */
    async get(key: string, loader: () => Promise<T>): Promise<T> {
        const hit = this.store.get(key);
        if (hit && hit.expiresAt > Date.now()) return hit.value;

        const value = await loader();
        this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
    }

    /** Скидання після зміни довідника — щоб не чекати кінця TTL. */
    clear(): void {
        this.store.clear();
    }
}
