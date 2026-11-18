import type { Api, Transformer } from "grammy";
import logger from "../core/logger.js";
import { telegramBlocklist } from "./telegram-blocklist.js";

/**
 * Отримувач у списку заборонених Telegram ID. Навмисно без error_code і без фраз
 * «bot was blocked» / «chat not found» / «user is deactivated»: isBotBlocked() не має
 * сприймати це як блокування бота користувачем (інакше кандидатку архівують як BLOCKER).
 */
export class BlockedRecipientError extends Error {
    constructor() {
        super("Recipient is on the Telegram blocklist");
        this.name = "BlockedRecipientError";
    }
}

/**
 * Термінальний пропуск: адресат у списку заборонених. Вузли, що інакше повторюють спробу вічно
 * (маркер «надіслано» ставиться лише після успіху), мають трактувати це як «оброблено».
 * Це НЕ блокування бота користувачем: handleBlockedCandidate / BLOCKER сюди не маршрутизуємо.
 */
export function isBlocklistedRecipientError(err: unknown): boolean {
    return err instanceof BlockedRecipientError || (err as { name?: unknown } | null)?.name === "BlockedRecipientError";
}

const AUDIT_INTERVAL_MS = 60 * 60 * 1000;
/** telegramId -> час останнього аудиту; записи старші за годину прибираються при кожному записі. */
const lastAuditedAt = new Map<number, number>();

function shouldAudit(chatId: number): boolean {
    const now = Date.now();
    for (const [id, at] of lastAuditedAt) {
        if (now - at >= AUDIT_INTERVAL_MS) lastAuditedAt.delete(id);
    }
    if (lastAuditedAt.has(chatId)) return false;
    lastAuditedAt.set(chatId, now);
    return true;
}

/** chat_id як додатне ціле (number або рядок цифр); групи, канали, @name -> null. */
function positiveChatId(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        const n = Number(value);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
    return null;
}

export const blocklistOutgoingTransformer: Transformer = async (prev, method, payload, signal) => {
    // Відкликання вже доставленого (revoke розсилки) має працювати і для пізніше заблокованого чату.
    if (method === "deleteMessage" || method === "deleteMessages") return prev(method, payload, signal);
    const chatId = positiveChatId((payload as { chat_id?: unknown } | undefined)?.chat_id);
    if (chatId === null) return prev(method, payload, signal);

    // Той самий вибір, що у вхідного гейта: список не завантажився -> не блокуємо.
    if (!telegramBlocklist.isLoaded() && !(await telegramBlocklist.ensureLoaded())) {
        return prev(method, payload, signal);
    }

    if (telegramBlocklist.has(chatId)) {
        if (shouldAudit(chatId)) {
            // Аудит не має права зламати контракт: заблокований виклик завжди кидає BlockedRecipientError.
            try {
                // Ліниво: audit-logger піднімає pino-файли при імпорті, а guard підключають модулі з моками logger.
                const { securityAudit } = await import("../core/audit-logger.js");
                securityAudit({
                    event: "security.blocked_recipient_skipped",
                    result: "failed",
                    actorType: "system",
                    telegramId: chatId,
                    entityType: "bot",
                    context: { method },
                });
            } catch (auditErr) {
                logger.warn({ err: auditErr }, "telegram-blocklist-outgoing: audit failed");
            }
        }
        throw new BlockedRecipientError();
    }
    return prev(method, payload, signal);
};

/** Ставити ОСТАННІМ у api.config.use: пізніший transformer обгортає попередні й викликається першим. */
export function installBlocklistOutgoingGuard(api: Api): void {
    api.config.use(blocklistOutgoingTransformer);
}
