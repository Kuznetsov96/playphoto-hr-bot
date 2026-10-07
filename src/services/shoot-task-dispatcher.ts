import { GrammyError, HttpError } from "grammy";
import type { Api } from "grammy";
import { logBusinessEvent } from "../core/log-events.js";
import { redis } from "../core/redis.js";
import {
    AwsBusinessApiError,
    SHOOT_TASK_FAILURE_REASONS,
    awsBusinessClient,
    type AwsShootTask,
} from "./aws-business-client.js";
import { renderShootTask } from "./shoot-task-render.js";

/**
 * Повідомлення фотографам про зйомки (план 4), pull-outbox вебаппа.
 *
 * Один процес: від перекриття опитувань усередині процесу береже startPolling (прапорець
 * «в польоті», як `running` інших диспетчерів). Якщо бот колись масштабують на кілька реплік або виходи перекриватимуться
 * (старий і новий контейнер разом), `GET pending` потребуватиме оренди рядків
 * (`FOR UPDATE SKIP LOCKED` з терміном) — Redis-ключ лише звужує вікно дубля, а не закриває його.
 */
export interface ShootTaskClient {
    pendingShootTasks(limit: number): Promise<{ items: AwsShootTask[]; invalidPublicIds: string[]; unidentifiableCount: number }>;
    markShootTaskDelivered(publicId: string, messageId?: number): Promise<void>;
    markShootTaskFailed(publicId: string, reason: string): Promise<void>;
}

/**
 * Доставка «хоча б раз» стає «один раз»: ключ ставиться одразу після успішної відправки. Поки
 * вебапп не прийняв `delivered`, publicId лежить у списку непідтверджених — відмітку
 * повторюємо звідти, навіть коли рядок уже не приходить у `pending` (його погасили, а
 * `delivered` вебапп приймає і з SUPERSEDED).
 */
export interface SentStore {
    get(publicId: string): Promise<number | null>;
    remember(publicId: string, messageId: number): Promise<void>;
    unconfirmed(): Promise<string[]>;
    confirmed(publicId: string): Promise<void>;
}

const SENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SENT_KEY = (publicId: string) => `shoot-task:sent:${publicId}`;
const UNCONFIRMED_KEY = "shoot-task:unconfirmed";

export const redisSentStore: SentStore = {
    async get(publicId) {
        const value = await redis.get(SENT_KEY(publicId));
        if (value === null) return null;
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
    /** Обидва записи в одному MULTI: ключ без запису в списку загубив би повтор delivered. */
    async remember(publicId, messageId) {
        const results = await redis
            .multi()
            .set(SENT_KEY(publicId), String(messageId), "EX", SENT_TTL_SECONDS)
            .sadd(UNCONFIRMED_KEY, publicId)
            .exec();
        if (results === null) throw new Error("SHOOT_TASK_REMEMBER_ABORTED");
        for (const [error] of results) {
            if (error) throw error;
        }
    },
    async unconfirmed() {
        return redis.smembers(UNCONFIRMED_KEY);
    },
    async confirmed(publicId) {
        await redis.srem(UNCONFIRMED_KEY, publicId);
    },
};

const PENDING_LIMIT = 50;
const NO_TARGET = "SHOOT_TASK_NO_TARGET";

/** Лише publicId, kind і статус: payload несе телефон та імена, текст — теж. */
function logEvent(
    event: string,
    result: "success" | "failure",
    safeContext?: Record<string, string | number>,
): void {
    logBusinessEvent({
        event,
        actorType: "system",
        actorRole: "system",
        result,
        module: "shoot-task-dispatcher",
        operation: "runOnce",
        ...(safeContext ? { safeContext } : {}),
    });
}

/** Опис Telegram порівнюється без регістру й по підрядку: префікс «Bad Request: » і хвіст різняться. */
function describes(error: GrammyError, phrase: string): boolean {
    return (error.description ?? "").toLowerCase().includes(phrase);
}

/**
 * Тимчасові збої Telegram: 429, 5xx і мережа. Зазвичай їх уже поглинув autoRetry (core/bot.ts);
 * якщо дійшли сюди — рядок лишається PENDING і прийде наступної хвилини, без витрати спроби.
 */
function transient(error: unknown): boolean {
    if (error instanceof HttpError) return true;
    return error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500);
}

function failureReason(error: unknown, kind: AwsShootTask["kind"]): string {
    if (error instanceof GrammyError) {
        if (error.error_code === 403) return SHOOT_TASK_FAILURE_REASONS.BLOCKED;
        const gone = describes(error, "message to edit not found") || describes(error, "message_id_invalid");
        if (kind === "REDACT" && gone) return SHOOT_TASK_FAILURE_REASONS.MESSAGE_GONE;
        if (kind === "REDACT" && describes(error, "message is not modified")) return SHOOT_TASK_FAILURE_REASONS.NOT_MODIFIED;
        return `TG_${error.error_code}`;
    }
    if (error instanceof HttpError) return "HTTP_ERROR";
    if (error instanceof Error && error.message === NO_TARGET) return NO_TARGET;
    return "SEND_FAILED";
}

/** Мережа, таймаут, 5xx, 408/429 — повторюємо; інша 4xx остаточна (рядка немає або він закритий). */
function retryable(error: unknown): boolean {
    if (!(error instanceof AwsBusinessApiError)) return true;
    return error.status >= 500 || error.status === 408 || error.status === 429;
}

export function createShootTaskDispatcher(
    api: Pick<Api, "sendMessage" | "editMessageText">,
    client: ShootTaskClient = awsBusinessClient,
    store: SentStore = redisSentStore,
) {
    /**
     * Запасна пам’ять процесу на випадок, коли Telegram уже прийняв повідомлення, а Redis пару
     * не записав: без неї рядок, що повернувся в pending, пішов би вдруге. Запис живе, доки
     * пара не ляже в Redis і вебапп не прийме delivered. Рестарт процесу її втрачає — тоді
     * вікно дубля лишається, але лише при двох збоях поспіль (Redis і відмітка).
     */
    const unstored = new Map<string, { messageId: number; stored: boolean; confirmed: boolean }>();

    async function safeMarkFailed(publicId: string, reason: string, kind?: string): Promise<void> {
        try {
            await client.markShootTaskFailed(publicId, reason);
        } catch {
            logEvent("bot.shoot_tasks.mark_failed_failed", "failure", { publicId, ...(kind ? { kind } : {}), status: reason });
        }
    }

    async function forget(publicId: string): Promise<void> {
        try {
            await store.confirmed(publicId);
        } catch {
            logEvent("bot.shoot_tasks.dedupe_write_failed", "failure", { publicId });
        }
    }

    /**
     * Telegram уже прийняв: збій відмітки не привід для failed — повторимо лише delivered.
     * `retry` — мережа/5xx, повторити; `dropped` — остаточна 4xx, повторювати нічого.
     */
    async function confirm(publicId: string, messageId: number, kind?: string): Promise<"ok" | "retry" | "dropped"> {
        try {
            await client.markShootTaskDelivered(publicId, messageId);
        } catch (error: unknown) {
            const again = retryable(error);
            logEvent("bot.shoot_tasks.mark_delivered_failed", "failure", {
                publicId,
                ...(kind ? { kind } : {}),
                status: again ? "RETRY" : "DROPPED",
            });
            if (!again) await forget(publicId);
            return again ? "retry" : "dropped";
        }
        await forget(publicId);
        return "ok";
    }

    async function deliver(item: AwsShootTask): Promise<number> {
        const chatId = Number(item.telegramId);
        const { text, keyboard } = renderShootTask(item);
        if (item.kind === "REDACT") {
            if (item.targetMessageId === null) throw new Error(NO_TARGET);
            await api.editMessageText(chatId, item.targetMessageId, text, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
                reply_markup: { inline_keyboard: [] },
            });
            return item.targetMessageId;
        }
        const sent = await api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...(keyboard === null ? {} : { reply_markup: keyboard }),
        });
        return sent.message_id;
    }

    async function retryUnstored(): Promise<void> {
        for (const [publicId, entry] of unstored) {
            if (!entry.stored) {
                try {
                    await store.remember(publicId, entry.messageId);
                    entry.stored = true;
                } catch {
                    logEvent("bot.shoot_tasks.dedupe_write_failed", "failure", { publicId });
                }
            }
            if (!entry.confirmed) entry.confirmed = (await confirm(publicId, entry.messageId)) !== "retry";
            else if (entry.stored) await forget(publicId);
            if (entry.stored && entry.confirmed) unstored.delete(publicId);
        }
    }

    /**
     * Відмітки, що загубилися раніше. Повертає publicId, відмітку яких і тепер не прийнято, —
     * основний цикл їх не чіпає до наступного опитування.
     */
    async function retryUnconfirmed(): Promise<Set<string>> {
        const stuck = new Set<string>();
        let ids: string[];
        try {
            ids = await store.unconfirmed();
        } catch {
            logEvent("bot.shoot_tasks.dedupe_unavailable", "failure");
            return stuck;
        }
        for (const publicId of ids) {
            let messageId: number | null;
            try {
                messageId = await store.get(publicId);
            } catch {
                stuck.add(publicId);
                continue;
            }
            // Ключ вийшов за 7 діб — повторювати нічим.
            if (messageId === null) {
                await forget(publicId);
                continue;
            }
            if ((await confirm(publicId, messageId)) === "retry") stuck.add(publicId);
        }
        return stuck;
    }

    return {
        async runOnce(): Promise<void> {
            await retryUnstored();
            const stuck = await retryUnconfirmed();
            const { items, invalidPublicIds, unidentifiableCount } = await client.pendingShootTasks(PENDING_LIMIT);
            if (unidentifiableCount > 0) {
                logEvent("bot.shoot_tasks.unidentifiable", "failure", { count: unidentifiableCount });
            }
            for (const id of invalidPublicIds) await safeMarkFailed(id, SHOOT_TASK_FAILURE_REASONS.PAYLOAD_INVALID);
            for (const item of items) {
                if (stuck.has(item.publicId) || unstored.has(item.publicId)) continue;
                let messageId: number | null;
                try {
                    messageId = await store.get(item.publicId);
                } catch {
                    // Без дедупу не шлемо: рядок лишиться PENDING і прийде наступної хвилини.
                    logEvent("bot.shoot_tasks.dedupe_unavailable", "failure", { publicId: item.publicId, kind: item.kind });
                    continue;
                }
                if (messageId === null) {
                    try {
                        messageId = await deliver(item);
                    } catch (error: unknown) {
                        // Лише код: сирий опис Telegram і GrammyError.payload несуть текст повідомлення.
                        const reason = failureReason(error, item.kind);
                        if (transient(error)) {
                            logEvent("bot.shoot_tasks.send_deferred", "failure", { publicId: item.publicId, kind: item.kind, status: reason });
                            continue;
                        }
                        await safeMarkFailed(item.publicId, reason, item.kind);
                        logEvent("bot.shoot_tasks.send_failed", "failure", { publicId: item.publicId, kind: item.kind, status: reason });
                        continue;
                    }
                    try {
                        await store.remember(item.publicId, messageId);
                    } catch {
                        logEvent("bot.shoot_tasks.dedupe_write_failed", "failure", { publicId: item.publicId, kind: item.kind });
                        const confirmed = (await confirm(item.publicId, messageId, item.kind)) !== "retry";
                        unstored.set(item.publicId, { messageId, stored: false, confirmed });
                        continue;
                    }
                }
                if ((await confirm(item.publicId, messageId, item.kind)) === "ok") {
                    logEvent("bot.shoot_tasks.delivered", "success", { publicId: item.publicId, kind: item.kind, status: "SENT" });
                }
            }
        },
    };
}

/**
 * Цикл опитування з прапорцем «в польоті» (опитування не перекриваються в одному процесі) і
 * `stop`, що чекає опитування в польоті: інакше зупинка закрила б Redis між відправкою і
 * записом пари — і після рестарту повідомлення пішло б удруге.
 */
export function startPolling(
    runOnce: () => Promise<void>,
    intervalMs: number,
    onError: (error: unknown) => void,
): { timer: NodeJS.Timeout; stop(timeoutMs: number): Promise<boolean> } {
    let inFlight: Promise<void> | null = null;
    const timer = setInterval(() => {
        if (inFlight !== null) return;
        inFlight = runOnce()
            .catch(onError)
            .finally(() => {
                inFlight = null;
            });
    }, intervalMs);
    return {
        timer,
        async stop(timeoutMs) {
            clearInterval(timer);
            if (inFlight === null) return true;
            let timeout: NodeJS.Timeout | undefined;
            const expired = new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            });
            try {
                return await Promise.race([inFlight.then(() => true), expired]);
            } finally {
                clearTimeout(timeout);
            }
        },
    };
}
