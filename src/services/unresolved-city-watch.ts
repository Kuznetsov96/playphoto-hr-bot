import { logBusinessEvent } from "../core/log-events.js";
import { systemStateRepository } from "../repositories/system-state-repository.js";

/** Список точек с городом вне справочника; пишется синком после успешного прохода. */
export const UNRESOLVED_CITIES_KEY = "aws-business-sync:unresolved-cities";

/** Когда по городу в последний раз слали предупреждение: { город: ISO-время }. */
export const LAST_ALERT_KEY = "unresolved-cities:last-alert";

/** Повтор по одному и тому же городу не чаще раза в сутки. */
export const CITY_ALERT_REPEAT_MS = 24 * 60 * 60_000;

const CHECK_INTERVAL_MS = 10 * 60_000;

export type UnresolvedCity = { city: string; locationName: string };

/**
 * Точки, чей город веб-приложение не нашло в справочнике (`cityUk === null`).
 * Отсутствующее поле (`undefined`) — это старый вебапп, он не считается.
 */
export function findUnresolvedCities(
    locations: { city: string; name: string; cityUk?: string | null | undefined }[],
): UnresolvedCity[] {
    return locations
        .filter((location) => location.cityUk === null)
        .map((location) => ({ city: location.city, locationName: location.name }));
}

/** Города, по которым пора предупреждать: без записи или с записью старше суток. */
export function pickCitiesToAlert(
    unresolved: UnresolvedCity[],
    alertedAt: Record<string, string>,
    now: Date,
): string[] {
    const result: string[] = [];
    for (const { city } of unresolved) {
        if (result.includes(city)) continue;
        const raw = alertedAt[city];
        const last = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
        if (Number.isNaN(last) || now.getTime() - last >= CITY_ALERT_REPEAT_MS) result.push(city);
    }
    return result;
}

export function buildCityAlertText(city: string, locationName: string): string {
    return `⚠️ Місто ${city} немає в довіднику, точка ${locationName}`;
}

type CityWatchApi = { sendMessage(chatId: number, text: string): Promise<unknown> };
type CityWatchStore = {
    getJson<T>(key: string): Promise<T | null>;
    setJson(key: string, value: unknown): Promise<void>;
};

/**
 * Один проход проверки: читает список от синка, шлёт предупреждения владельцу
 * (ADMIN_IDS[0], как в startScheduleMirrorWatch) и обновляет last-alert.
 * Город записывается как предупреждённый только если отправка удалась,
 * иначе следующий проход повторит. Вернувшиеся в норму города удаляются.
 */
export async function runUnresolvedCityCheck(deps: {
    api: CityWatchApi;
    adminIds: number[];
    store: CityWatchStore;
    now: Date;
}): Promise<void> {
    const { api, adminIds, store, now } = deps;
    const stored = await store.getJson<unknown>(UNRESOLVED_CITIES_KEY);
    const unresolved: UnresolvedCity[] = Array.isArray(stored)
        ? stored.filter(
              (item): item is UnresolvedCity =>
                  typeof item === "object" && item !== null &&
                  typeof (item as UnresolvedCity).city === "string" &&
                  typeof (item as UnresolvedCity).locationName === "string",
          )
        : [];

    const previous = await store.getJson<Record<string, string>>(LAST_ALERT_KEY);
    const alertedAt: Record<string, string> =
        previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};

    const toAlert = pickCitiesToAlert(unresolved, alertedAt, now);

    // Только города, всё ещё вне справочника: остальные записи удаляются.
    const next: Record<string, string> = {};
    for (const { city } of unresolved) {
        if (alertedAt[city] !== undefined) next[city] = alertedAt[city];
    }

    // Владелец — ADMIN_IDS[0]: рассылка всем админам приучает их смахивать алерты.
    const owner = adminIds.at(0);
    for (const city of toAlert) {
        const locations = unresolved.filter((item) => item.city === city).map((item) => item.locationName);
        const text = buildCityAlertText(city, locations.join(", "));
        let delivered = false;
        if (owner !== undefined) {
            try {
                await api.sendMessage(owner, text);
                delivered = true;
            } catch (error) {
                // Сбой отправки не роняет цикл, но виден в логах.
                logBusinessEvent({
                    event: "bot.unresolved_city.send_failed",
                    level: "warn",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    module: "unresolved-city-watch",
                    operation: "alert",
                    safeContext: {
                        adminId: owner,
                        errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                    },
                });
            }
        }
        if (delivered) next[city] = now.toISOString();
    }

    if (JSON.stringify(next) !== JSON.stringify(alertedAt)) {
        await store.setJson(LAST_ALERT_KEY, next);
    }
}

/** Раз в 10 минут запускает проверку городов вне справочника. */
export function startUnresolvedCityWatch(api: CityWatchApi, adminIds: number[]): NodeJS.Timeout {
    const run = () => runUnresolvedCityCheck({ api, adminIds, store: systemStateRepository, now: new Date() });

    const timer = setInterval(() => {
        void run().catch((error: unknown) => {
            logBusinessEvent({
                event: "bot.unresolved_city.check_failed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                module: "unresolved-city-watch",
                operation: "watch",
                safeContext: {
                    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
                },
            });
        });
    }, CHECK_INTERVAL_MS);
    timer.unref();
    return timer;
}
