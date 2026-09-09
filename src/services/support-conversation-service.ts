import { supportRepository } from "../repositories/support-repository.js";
import { redis } from "../core/redis.js";
import logger from "../core/logger.js";

type ActiveTicket = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveTicketByUser>>>;
type ActiveOutgoingTopic = NonNullable<Awaited<ReturnType<typeof supportRepository.findActiveOutgoingTopicByUser>>>;

export type ActiveSupportConversation =
    | { kind: "ticket"; id: number; topicId: number | null; ticket: ActiveTicket }
    | { kind: "outgoing"; id: number; topicId: number; outgoingTopic: ActiveOutgoingTopic };

/**
 * Скільки живе лок створення розмови. Достатньо на createForumTopic +
 * дві відправки в Telegram, але не настільки довго, щоб мертвий процес
 * блокував відправки надовго.
 */
const LOCK_TTL_MS = 30_000;

/**
 * Скільки чекати чужий лок, перш ніж здатися. Раніше лок брався одним
 * `NX` без очікування: щойно два оновлення для однієї людини йшли поруч
 * (подвійний тап, паралельні воркери), друге падало з помилкою — і
 * повідомлення йшло повз підтримку, бо помилку ковтав catch вище.
 *
 * Чекати сумарно секунду безпечно: обробник callback усе одно має
 * вкластися в телеграмівське вікно, а створення теми триває мілісекунди.
 */
const LOCK_WAIT_TOTAL_MS = 1_000;
const LOCK_RETRY_DELAY_MS = 50;

export class SupportConversationService {
    async withUserLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
        const lockKey = `support:conversation-lock:${userId}`;
        const token = `${process.pid}:${Date.now()}:${Math.random()}`;

        const deadline = Date.now() + LOCK_WAIT_TOTAL_MS;
        let acquired = await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
        while (acquired !== "OK" && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
            acquired = await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
        }

        if (acquired !== "OK") {
            throw new Error(`Support conversation for ${userId} is being created by another process`);
        }

        try {
            return await operation();
        } finally {
            await redis.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                1,
                lockKey,
                token,
            ).catch(error => logger.error({ err: error, userId }, "Failed to release support conversation lock"));
        }
    }

    /**
     * A user has one canonical support route. User-created tickets take
     * precedence over admin-created outgoing topics because they represent an
     * already active request owned by the user.
     */
    async resolveActive(userId: string): Promise<ActiveSupportConversation | null> {
        const ticket = await supportRepository.findActiveTicketByUser(userId);
        if (ticket) {
            return {
                kind: "ticket",
                id: ticket.id,
                topicId: ticket.topicId,
                ticket,
            };
        }

        const outgoingTopic = await supportRepository.findActiveOutgoingTopicByUser(userId);
        if (!outgoingTopic) return null;

        return {
            kind: "outgoing",
            id: outgoingTopic.id,
            topicId: outgoingTopic.topicId,
            outgoingTopic,
        };
    }

    /**
     * Повертає активну розмову або створює нову.
     *
     * `created` каже викликачу, що саме сталося. Без цього прапорця
     * адмінський екран не міг відрізнити «створено нову гілку» від
     * «дописано в стару» і рапортував успіх однаково — а це різні речі:
     * у другому випадку повідомлення лягає у гілку, яку ніхто не читає,
     * бо вона висить у чаті з минулого разу.
     */
    async resolveOrCreateOutgoing(
        userId: string,
        createOutgoing: () => Promise<ActiveOutgoingTopic>
    ): Promise<ActiveSupportConversation & { created: boolean }> {
        return this.withUserLock(userId, async () => {
            const active = await this.resolveActive(userId);
            if (active) return { ...active, created: false };

            const outgoingTopic = await createOutgoing();
            return {
                kind: "outgoing" as const,
                id: outgoingTopic.id,
                topicId: outgoingTopic.topicId,
                outgoingTopic,
                created: true,
            };
        });
    }
}

export const supportConversationService = new SupportConversationService();
