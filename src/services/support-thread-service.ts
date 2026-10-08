import type { Api } from "grammy";
import type { SupportThread } from "@prisma/client";
import logger from "../core/logger.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import type { SupportThreadRepository } from "../repositories/support-thread-repository.js";
import {
    buildThreadTitle,
    formatThreadPlace,
    kyivDay,
    nextStatus,
    pickMainLocationId,
    renderThreadCard,
    shortDay,
    threadNameLabel,
    type ThreadEvent,
    type ThreadStatus,
} from "../utils/support-thread-format.js";
import type { ThreadIcons } from "./support-thread-icons.js";

/**
 * Життєвий цикл постійної теми співробітниці (spec 2026-10-08): створення під
 * локом, назва, закріплена картка, статус-іконка, архів. Без ctx: працює і з
 * обробників, і з воркера.
 */

export type ThreadPlace = { id: string; name: string; branch: string | null; city: string };

export type ThreadPerson = {
    userId: string;
    staffId: string;
    fullName: string;
    surnameNameDot: string | null;
    phone: string | null;
    username: string | null;
    isActive: boolean;
    homeLocation: ThreadPlace | null;
};

export type ThreadPeople = {
    getPerson(userId: string): Promise<ThreadPerson | null>;
    /** Точки змін за −60…+30 днів, по одній на зміну. */
    recentShiftLocations(staffId: string, now: Date): Promise<ThreadPlace[]>;
    /** Сьогоднішня зміна з того ж джерела, що й хаб фотографині. */
    todayShift(staffId: string, now: Date): Promise<{ location: ThreadPlace; time: string | null } | null>;
};

export type ThreadDeps = {
    repo: Pick<SupportThreadRepository, "findByUserId" | "findById" | "create" | "update" | "listByStatusNot" | "listCollidingSurnames">;
    people: ThreadPeople;
    lock: <T>(userId: string, fn: () => Promise<T>) => Promise<T>;
    chatId: () => number;
    icons: (api: Api) => Promise<ThreadIcons>;
    sleep: (ms: number) => Promise<void>;
    callTargets: () => { kuznetsov: number | undefined; hupalova: number | undefined };
};

/** Пауза між темами у фонових обходах: ліміт Telegram — 20 повідомлень на хвилину в групі. */
const SWEEP_PAUSE_MS = 3_000;

export function topicLink(chatId: bigint | number, topicId: number): string {
    const raw = String(chatId);
    const internal = raw.startsWith("-100") ? raw.slice(4) : raw.replace("-", "");
    return `https://t.me/c/${internal}/${topicId}`;
}

function describeError(error: unknown): string {
    const value = error as { description?: string; message?: string } | undefined;
    return String(value?.description ?? value?.message ?? error).toLowerCase();
}

export function isTopicGoneError(error: unknown): boolean {
    const text = describeError(error);
    return text.includes("thread not found") || text.includes("topic_deleted") || text.includes("topic_id_invalid") || text.includes("message thread not found");
}

export class SupportThreadService {
    constructor(private readonly deps: ThreadDeps) {}

    async ensureThread(api: Api, userId: string): Promise<SupportThread> {
        const existing = await this.deps.repo.findByUserId(userId);
        if (existing) return existing;

        return this.deps.lock(userId, async () => {
            const again = await this.deps.repo.findByUserId(userId);
            if (again) return again;

            const person = await this.deps.people.getPerson(userId);
            if (!person) throw new Error(`Support thread: no staff profile for user ${userId}`);

            const view = await this.describe(person, new Date());
            const icons = await this.deps.icons(api);
            const chatId = this.deps.chatId();
            const topic = await api.createForumTopic(chatId, view.title, icons.ANSWERED ? { icon_custom_emoji_id: icons.ANSWERED } : {});
            const thread = await this.deps.repo.create({ userId, chatId: BigInt(chatId), topicId: topic.message_thread_id, title: view.title });
            return this.publishCard(api, thread, person, view);
        });
    }

    async applyStatus(api: Api, thread: SupportThread, event: ThreadEvent): Promise<SupportThread> {
        const next = nextStatus({ status: thread.status as ThreadStatus, escalatedToTelegramId: thread.escalatedToTelegramId }, event);
        if (next.status === thread.status && next.escalatedToTelegramId === thread.escalatedToTelegramId) return thread;

        const updated = await this.deps.repo.update(thread.id, { status: next.status, escalatedToTelegramId: next.escalatedToTelegramId });
        if (next.status !== thread.status) {
            const icon = (await this.deps.icons(api))[next.status];
            if (icon) {
                await api.editForumTopic(Number(thread.chatId), thread.topicId, { icon_custom_emoji_id: icon }).catch(error => {
                    logger.warn({ err: error, threadId: thread.id, status: next.status }, "Support thread icon update failed");
                });
            }
        }
        return updated;
    }

    async refreshCard(api: Api, thread: SupportThread, now: Date = new Date()): Promise<void> {
        const person = await this.deps.people.getPerson(thread.userId);
        if (!person) return;
        const view = await this.describe(person, now, thread.status === "ARCHIVED" ? shortDay(kyivDay(thread.updatedAt)) : null);

        if (thread.cardMessageId) {
            try {
                const keyboard = this.cardKeyboard(thread);
                await api.editMessageText(Number(thread.chatId), thread.cardMessageId, view.card, {
                    parse_mode: "HTML",
                    ...(keyboard ? { reply_markup: keyboard } : {}),
                });
                await this.deps.repo.update(thread.id, { cardDay: kyivDay(now) });
                return;
            } catch (error) {
                const text = describeError(error);
                if (text.includes("message is not modified")) {
                    await this.deps.repo.update(thread.id, { cardDay: kyivDay(now) });
                    return;
                }
                if (!text.includes("message to edit not found") && !text.includes("message_id_invalid")) {
                    logger.warn({ err: error, threadId: thread.id }, "Support thread card update failed");
                    return;
                }
            }
        }
        await this.publishCard(api, thread, person, view);
    }

    /** Перший рядок картки — «сьогодні»; оновлюється при першому повідомленні дня. */
    async refreshCardIfStale(api: Api, thread: SupportThread, now: Date = new Date()): Promise<void> {
        if (thread.cardDay === kyivDay(now)) return;
        await this.refreshCard(api, thread, now);
    }

    async refreshTitle(api: Api, thread: SupportThread, now: Date = new Date()): Promise<SupportThread> {
        const person = await this.deps.people.getPerson(thread.userId);
        if (!person) return thread;
        const view = await this.describe(person, now);
        if (view.title === thread.title) return thread;
        try {
            await api.editForumTopic(Number(thread.chatId), thread.topicId, { name: view.title });
        } catch (error) {
            logger.warn({ err: error, threadId: thread.id }, "Support thread rename failed");
            return thread;
        }
        return this.deps.repo.update(thread.id, { title: view.title });
    }

    async noticeIfAway(api: Api, thread: SupportThread, now: Date = new Date()): Promise<SupportThread> {
        const day = kyivDay(now);
        if (thread.noticeDay === day) return thread;

        const person = await this.deps.people.getPerson(thread.userId);
        const updated = await this.deps.repo.update(thread.id, { noticeDay: day });
        if (!person) return updated;

        const view = await this.describe(person, now);
        if (view.todayLocationId && view.mainLocationId && view.todayLocationId !== view.mainLocationId && view.todayPlace) {
            await api.sendMessage(Number(thread.chatId), ADMIN_TEXTS["support-thread-away"]({ place: view.todayPlace }), {
                message_thread_id: thread.topicId,
            });
        }
        return updated;
    }

    async recreateTopic(api: Api, thread: SupportThread): Promise<SupportThread> {
        const person = await this.deps.people.getPerson(thread.userId);
        const view = person ? await this.describe(person, new Date()) : null;
        const title = view?.title ?? thread.title;
        const icons = await this.deps.icons(api);
        const icon = icons[thread.status as ThreadStatus];
        const topic = await api.createForumTopic(Number(thread.chatId), title, icon ? { icon_custom_emoji_id: icon } : {});
        const moved = await this.deps.repo.update(thread.id, { topicId: topic.message_thread_id, title, cardMessageId: null });
        await api.sendMessage(Number(thread.chatId), ADMIN_TEXTS["support-thread-recreated"], { message_thread_id: topic.message_thread_id });
        logger.warn({ threadId: thread.id, oldTopicId: thread.topicId, newTopicId: topic.message_thread_id }, "Support thread topic recreated");
        if (!person || !view) return moved;
        return this.publishCard(api, moved, person, view);
    }

    /** Щоденний обхід: назва (основна точка могла змінитися) і рядок «сьогодні». */
    async dailyRefresh(api: Api, now: Date = new Date()): Promise<void> {
        const threads = await this.deps.repo.listByStatusNot("ARCHIVED");
        for (const thread of threads) {
            try {
                const renamed = await this.refreshTitle(api, thread, now);
                await this.refreshCard(api, renamed, now);
            } catch (error) {
                logger.warn({ err: error, threadId: thread.id }, "Support thread daily refresh failed");
            }
            await this.deps.sleep(SWEEP_PAUSE_MS);
        }
    }

    async archiveInactive(api: Api, now: Date = new Date()): Promise<void> {
        const threads = await this.deps.repo.listByStatusNot("ARCHIVED");
        for (const thread of threads) {
            try {
                const person = await this.deps.people.getPerson(thread.userId);
                if (!person || person.isActive) continue;
                const archived = await this.applyStatus(api, thread, { kind: "archived" });
                await api.sendMessage(Number(thread.chatId), ADMIN_TEXTS["support-thread-archived"]({ day: shortDay(kyivDay(now)) }), {
                    message_thread_id: thread.topicId,
                });
                await this.refreshCard(api, { ...archived, updatedAt: now }, now);
            } catch (error) {
                logger.warn({ err: error, threadId: thread.id }, "Support thread archive failed");
            }
        }
    }

    private async describe(person: ThreadPerson, now: Date, archivedAt: string | null = null) {
        const [shiftPlaces, today, colliding] = await Promise.all([
            this.deps.people.recentShiftLocations(person.staffId, now),
            this.deps.people.todayShift(person.staffId, now),
            this.deps.repo.listCollidingSurnames(),
        ]);
        const mainLocationId = pickMainLocationId(shiftPlaces.map(place => ({ locationId: place.id })), person.homeLocation?.id ?? null);
        const mainLocation = shiftPlaces.find(place => place.id === mainLocationId)
            ?? (person.homeLocation?.id === mainLocationId ? person.homeLocation : null);
        const mainPlace = mainLocation ? formatThreadPlace(mainLocation) : null;
        const todayPlace = today ? formatThreadPlace(today.location) : null;

        const title = buildThreadTitle(threadNameLabel(person, colliding), mainPlace);
        const card = renderThreadCard({
            today: { day: shortDay(kyivDay(now)), place: todayPlace, time: today?.time ?? null },
            archivedAt,
            fullName: person.fullName,
            username: person.username,
            phone: person.phone,
            mainPlace,
        });
        return { title, card, mainPlace, todayPlace, mainLocationId, todayLocationId: today?.location.id ?? null };
    }

    private cardKeyboard(thread: SupportThread) {
        const targets = this.deps.callTargets();
        const row: { text: string; callback_data: string }[] = [];
        if (targets.kuznetsov) row.push({ text: ADMIN_TEXTS["support-thread-btn-call-kuznetsov"], callback_data: `sth:c:${thread.id}:k` });
        if (targets.hupalova) row.push({ text: ADMIN_TEXTS["support-thread-btn-call-hupalova"], callback_data: `sth:c:${thread.id}:h` });
        return row.length ? { inline_keyboard: [row] } : undefined;
    }

    private async publishCard(api: Api, thread: SupportThread, _person: ThreadPerson, view: { card: string }): Promise<SupportThread> {
        const chatId = Number(thread.chatId);
        const keyboard = this.cardKeyboard(thread);
        const message = await api.sendMessage(chatId, view.card, {
            message_thread_id: thread.topicId,
            parse_mode: "HTML",
            ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        await api.pinChatMessage(chatId, message.message_id, { disable_notification: true }).catch(error => {
            logger.warn({ err: error, threadId: thread.id }, "Support thread card pin failed");
        });
        return this.deps.repo.update(thread.id, { cardMessageId: message.message_id, cardDay: kyivDay(new Date()) });
    }
}
