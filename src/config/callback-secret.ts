import "dotenv/config";

/**
 * Ключ підпису callback-даних (див. utils/signed-callback.ts).
 *
 * Раніше він жив прямо в signed-callback.ts рядком, що закінчувався
 * літералом:
 *
 *     process.env.APP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY ||
 *     process.env.BOT_TOKEN || "dev-callback-secret"
 *
 * Три проблеми одразу. ENCRYPTION_KEY не описаний у схемі config.ts взагалі —
 * таке значення ніхто не валідує. Модуль не викликав dotenv, тож покладався
 * на те, що хтось інший зробить це раніше. І головне: константа модульного
 * рівня обчислюється один раз, тож достатньо було імпортувати файл до
 * завантаження .env — наприклад, зі скрипта в src/scripts/, — щоб ключ
 * назавжди зафіксувався на «dev-callback-secret». Публічно відомий ключ, яким
 * підписується будь-який callback.
 *
 * Тепер: власний `import "dotenv/config"` знімає залежність від порядку
 * імпортів, а відсутність секрету — помилка запуску, а не тихий дефолт.
 *
 * Модуль навмисно окремий і без залежностей, а не частина config.ts: цей
 * ключ читає utils/signed-callback.ts, який тягнуть майже всі хендлери, і
 * кожен тест, що мокає config.js частково (таких десятки), падав би на
 * відсутньому експорті.
 */
const secret = process.env.APP_ENCRYPTION_KEY || process.env.BOT_TOKEN;

if (!secret) {
    throw new Error(
        "Callback signing secret is missing: set APP_ENCRYPTION_KEY or BOT_TOKEN. " +
        "Refusing to run with a default key — it would let anyone forge callback data.",
    );
}

export const CALLBACK_SECRET: string = secret;
