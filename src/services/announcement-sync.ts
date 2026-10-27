import prisma from "../db/core.js";
import { ACTIONS_DONE_LIMIT } from "../repositories/broadcast-action-repository.js";
import logger from "../core/logger.js";
import { ANNOUNCEMENTS_SYNC_ENABLED, TEAM_CHATS } from "../config.js";
import { awsBusinessClient } from "./aws-business-client.js";
import type {
    AnnouncementActivity,
    AnnouncementChat,
    AnnouncementRecipient,
    AnnouncementSnapshot,
    SnapshotDeliveryStatus,
    SnapshotReplyStatus,
} from "./announcement-snapshot-types.js";

export const ANNOUNCEMENT_SYNC_JOB_NAME = "announcement-sync";
const FALLBACK_NAME = "Telegram user";
const SYNC_DELAY_MS = 3_000;

const DELIVERY_STATUSES = new Set<string>(["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED"]);

function deliveryStatus(raw: string): SnapshotDeliveryStatus {
    return DELIVERY_STATUSES.has(raw) ? (raw as SnapshotDeliveryStatus) : "PENDING";
}

/** dropped = бот перестал спрашивать этого человека (вышла из чата, заблокировала, неактуальное пожелание). */
function replyStatus(raw: string): SnapshotReplyStatus {
    if (raw === "confirmed") return "CONFIRMED";
    if (raw === "declined") return "DECLINED";
    if (raw === "dropped") return "DROPPED";
    return "PENDING";
}

function replyRank(raw: string): number {
    if (raw === "confirmed" || raw === "declined") return 2;
    if (raw === "pending") return 1;
    return 0;
}

type NamedUser = {
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    staffProfile?: { fullName: string } | null;
} | null | undefined;

function displayNameOf(user: NamedUser): string {
    const full = user?.staffProfile?.fullName?.trim();
    if (full) return full.slice(0, 300);
    const parts = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
    if (parts) return parts.slice(0, 300);
    if (user?.username) return `@${user.username}`.slice(0, 300);
    return FALLBACK_NAME;
}

function topicUrl(thread: { chatId: bigint; topicId: number } | null | undefined): string | undefined {
    if (!thread) return undefined;
    const raw = String(thread.chatId);
    // Ссылка t.me/c/<id>/<topic> есть только у супергрупп (-100…); иначе вебапп отвергнет весь снимок.
    if (!raw.startsWith("-100")) return undefined;
    const channelId = raw.slice(4);
    if (!/^\d+$/u.test(channelId)) return undefined;
    if (!Number.isInteger(thread.topicId) || thread.topicId <= 0) return undefined;
    return `https://t.me/c/${channelId}/${thread.topicId}`;
}

/** Необязательное поле-дата: ключа нет, если даты нет (exactOptionalPropertyTypes). */
function opt<K extends string>(key: K, date: Date | null | undefined): { [P in K]?: string } {
    return date ? ({ [key]: date.toISOString() } as { [P in K]?: string }) : {};
}

const ACTIVITY_LIMIT = 1000;

/** Лимит вебаппа: оставляем САМЫЕ НОВЫЕ записи; SENT/DELIVERED/STOPPED/WITHDRAWN не отбрасываем никогда. */
function capActivity(sorted: AnnouncementActivity[]): AnnouncementActivity[] {
    if (sorted.length <= ACTIVITY_LIMIT) return sorted;
    const pinned = sorted.filter(a => a.kind !== "REMINDED");
    const reminders = sorted.filter(a => a.kind === "REMINDED");
    const keep = new Set(reminders.slice(-Math.max(0, ACTIVITY_LIMIT - pinned.length)));
    return sorted.filter(a => a.kind !== "REMINDED" || keep.has(a)).slice(-ACTIVITY_LIMIT);
}

export async function buildAnnouncementSnapshot(broadcastId: number): Promise<AnnouncementSnapshot> {
    const built = await loadSnapshot(broadcastId);
    if (!built) throw new Error(`Broadcast ${broadcastId} not found`);
    return built.snapshot;
}

async function loadSnapshot(broadcastId: number): Promise<{ publicId: string; snapshot: AnnouncementSnapshot } | null> {
    const broadcast = await prisma.broadcast.findUnique({
        where: { id: broadcastId },
        include: {
            deliveries: true,
            pingLogs: true,
            actionLogs: { orderBy: [{ doneAt: "desc" }, { publicId: "desc" }], take: ACTIONS_DONE_LIMIT, select: { publicId: true } },
            trackedMessages: { orderBy: { id: "asc" }, include: { pendingReplies: true } },
        },
    });
    if (!broadcast) return null;

    const userDeliveries = broadcast.deliveries.filter(d => d.targetType === "USER");
    const groupDeliveries = broadcast.deliveries.filter(d => d.targetType === "GROUP");
    const replies = broadcast.trackedMessages.flatMap(t => t.pendingReplies);

    const telegramIds = new Set<bigint>();
    userDeliveries.forEach(d => telegramIds.add(d.chatId));
    replies.forEach(r => telegramIds.add(r.userId));
    if (broadcast.initiatorId != null) telegramIds.add(broadcast.initiatorId);
    if (broadcast.withdrawnByTelegramId != null) telegramIds.add(broadcast.withdrawnByTelegramId);

    const users = telegramIds.size
        ? await prisma.user.findMany({
            where: { telegramId: { in: [...telegramIds] } },
            include: { staffProfile: { select: { fullName: true } }, supportThread: { select: { chatId: true, topicId: true } } },
        })
        : [];
    const userById = new Map(users.map(u => [String(u.telegramId), u]));

    const chatIds = groupDeliveries.map(d => d.chatId);
    const locations = chatIds.length
        ? await prisma.location.findMany({
            where: { telegramChatId: { in: chatIds } },
            select: { name: true, telegramChatId: true },
        })
        : [];
    const locationByChat = new Map(locations.map(l => [String(l.telegramChatId), l.name]));

    // Получатели: личные доставки + все ответчики (участники групп).
    const recipients = new Map<string, AnnouncementRecipient>();
    const ensure = (id: bigint): AnnouncementRecipient => {
        const key = String(id);
        let r = recipients.get(key);
        if (!r) {
            const user = userById.get(key);
            r = { telegramId: key, displayName: displayNameOf(user) };
            const url = topicUrl(user?.supportThread);
            if (url) r.supportTopicUrl = url;
            recipients.set(key, r);
        }
        return r;
    };

    for (const d of userDeliveries) {
        const r = ensure(d.chatId);
        r.deliveryStatus = deliveryStatus(d.status);
        if (d.sentAt) r.deliveredAt = d.sentAt.toISOString();
        if (d.lastError) r.deliveryError = d.lastError.slice(0, 500);
    }

    const bestReply = new Map<string, (typeof replies)[number]>();
    for (const r of replies) {
        const key = String(r.userId);
        const current = bestReply.get(key);
        if (!current || replyRank(r.status) > replyRank(current.status)) bestReply.set(key, r);
    }
    for (const [key, reply] of bestReply) {
        const r = ensure(BigInt(key));
        r.replyStatus = replyStatus(reply.status);
        if (reply.respondedAt) r.respondedAt = reply.respondedAt.toISOString();
        if (reply.declineReason) r.declineReason = reply.declineReason.slice(0, 2000);
    }

    const chats: AnnouncementChat[] = groupDeliveries.map(d => {
        const title = locationByChat.get(String(d.chatId)) ?? (Number(d.chatId) === TEAM_CHATS.HUB ? "HUB" : undefined);
        return {
            chatId: String(d.chatId),
            ...(title ? { title } : {}),
            deliveryStatus: deliveryStatus(d.status),
            ...(d.sentAt ? { deliveredAt: d.sentAt.toISOString() } : {}),
        };
    });

    const authorName = broadcast.authorName
        ?? (broadcast.initiatorId != null && userById.has(String(broadcast.initiatorId))
            ? displayNameOf(userById.get(String(broadcast.initiatorId)))
            : FALLBACK_NAME);

    const activity: AnnouncementActivity[] = [
        { at: broadcast.createdAt.toISOString(), kind: "SENT", actorName: authorName },
    ];
    if (broadcast.completedAt) {
        activity.push({
            at: broadcast.completedAt.toISOString(),
            kind: "DELIVERED",
            count: broadcast.deliveries.filter(d => d.status === "SENT").length,
        });
    }
    const pingsByMinute = new Map<string, { at: Date; chats: Set<string> }>();
    for (const p of broadcast.pingLogs) {
        const key = p.sentAt.toISOString().slice(0, 16);
        const group = pingsByMinute.get(key) ?? { at: p.sentAt, chats: new Set<string>() };
        if (p.sentAt < group.at) group.at = p.sentAt;
        group.chats.add(String(p.chatId));
        pingsByMinute.set(key, group);
    }
    for (const group of pingsByMinute.values()) {
        activity.push({ at: group.at.toISOString(), kind: "REMINDED", count: group.chats.size });
    }
    if (broadcast.remindersStoppedAt) {
        activity.push({
            at: broadcast.remindersStoppedAt.toISOString(),
            kind: "STOPPED",
            ...(broadcast.remindersStoppedByName ? { actorName: broadcast.remindersStoppedByName.slice(0, 300) } : {}),
        });
    }
    // Из вебаппа имя пришло с командой; у админки бота его собирают по Telegram id.
    const withdrawnByName = broadcast.withdrawnByName
        ? broadcast.withdrawnByName.slice(0, 300)
        : broadcast.withdrawnByTelegramId != null
            ? displayNameOf(userById.get(String(broadcast.withdrawnByTelegramId)))
            : undefined;
    if (broadcast.withdrawnAt) {
        activity.push({
            at: broadcast.withdrawnAt.toISOString(),
            kind: "WITHDRAWN",
            ...(withdrawnByName ? { actorName: withdrawnByName } : {}),
        });
    }
    activity.sort((a, b) => a.at.localeCompare(b.at));
    const cappedActivity = capActivity(activity);

    const nextPings = broadcast.trackedMessages.map(t => t.nextPingAt).filter((d): d is Date => !!d);
    const pingUntils = broadcast.trackedMessages.map(t => t.pingUntil).filter((d): d is Date => !!d);
    const minDate = (dates: Date[]) => dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : undefined;
    const maxDate = (dates: Date[]) => dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : undefined;

    // У старых рассылок Broadcast.buttonType может быть null — берём вид кнопки у отслеживаемого сообщения.
    const buttonType = broadcast.buttonType ?? broadcast.trackedMessages[0]?.buttonType ?? null;
    const replyMode: AnnouncementSnapshot["replyMode"] =
        buttonType === "preferences" ? "PREFERENCES"
            : buttonType === "none" || buttonType == null ? "NONE"
                : "CONFIRM";

    const snapshot: AnnouncementSnapshot = {
        snapshotAt: new Date().toISOString(),
        botBroadcastId: broadcast.id,
        source: broadcast.origin === "WEBAPP" ? "WEBAPP" : "BOT",
        ...(broadcast.initiatorId != null && broadcast.origin !== "WEBAPP" ? { authorTelegramId: String(broadcast.initiatorId) } : {}),
        authorName,
        ...(broadcast.messageText ? { messageHtml: broadcast.messageText.slice(0, 20_000) } : {}),
        ...(broadcast.targetSummary ? { targetSummary: broadcast.targetSummary.slice(0, 1000) } : {}),
        replyMode,
        attachmentKinds: (broadcast.attachmentKinds ?? []).slice(0, 50).map(k => k.slice(0, 40)),
        createdAt: broadcast.createdAt.toISOString(),
        ...opt("completedAt", broadcast.completedAt),
        ...opt("cancelledAt", broadcast.cancelledAt),
        ...opt("withdrawnAt", broadcast.withdrawnAt),
        ...(withdrawnByName ? { withdrawnByName } : {}),
        ...opt("remindersStoppedAt", broadcast.remindersStoppedAt),
        ...(broadcast.remindersStoppedByName ? { remindersStoppedByName: broadcast.remindersStoppedByName.slice(0, 300) } : {}),
        textAsCaption: broadcast.textAsCaption,
        actionsDone: broadcast.actionLogs.map(a => a.publicId),
        ...opt("nextReminderAt", minDate(nextPings)),
        ...opt("reminderUntil", maxDate(pingUntils)),
        recipients: [...recipients.values()].slice(0, 5000),
        chats: chats.slice(0, 1000),
        activity: cappedActivity,
    };
    return { publicId: broadcast.publicId, snapshot };
}

const LIVE_STATES = new Set(["waiting", "delayed", "prioritized", "waiting-children"]);

async function addDebounced(
    queue: { getJob: (id: string) => Promise<any>; add: (...args: any[]) => Promise<unknown> },
    jobId: string,
    broadcastId: number,
    delay: number = SYNC_DELAY_MS,
): Promise<"added" | "debounced" | "active"> {
    const existing = await queue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (LIVE_STATES.has(state)) return "debounced";
        if (state === "active") return "active";
        // completed/failed: BullMQ дедуплицирует по jobId даже у завершённых,
        // без удаления все последующие изменения никогда бы не ушли.
        await existing.remove();
    }
    await queue.add(
        ANNOUNCEMENT_SYNC_JOB_NAME,
        { broadcastId },
        { jobId, delay, attempts: 8, backoff: { type: "exponential", delay: 10_000 } },
    );
    return "added";
}

/**
 * Ставит отправку снимка рассылки в вебапп. Дебаунс по jobId: пока задача
 * ждёт, новые не добавляются. Воркер строит снимок в момент выполнения, так
 * что изменения до запуска всё равно попадут. Выключенный флаг — no-op.
 */
export async function enqueueAnnouncementSync(broadcastId: number): Promise<void> {
    if (!ANNOUNCEMENTS_SYNC_ENABLED) return;
    const { defaultQueue } = await import("../core/queue.js");
    const jobId = `announcement-sync-${broadcastId}`;
    const result = await addDebounced(defaultQueue, jobId, broadcastId);
    if (result === "active") {
        // Задача уже строит снимок и могла не увидеть эту правку — ставим следующую.
        await addDebounced(defaultQueue, `${jobId}-next`, broadcastId);
    }
}

const BACKFILL_PAGE_SIZE = 200;
const BACKFILL_STAGGER_MS = 500;

/**
 * Разовый перенос: ставит снимок каждой существующей рассылки. Задачам задана
 * нарастающая задержка, чтобы вебапп (2 CPU, пул БД 5) не получил сотни PUT
 * разом. Возвращает число рассылок, для которых синк поставлен или уже ждёт.
 */
export async function enqueueAllAnnouncementSyncs(): Promise<number> {
    if (!ANNOUNCEMENTS_SYNC_ENABLED) {
        logger.warn("Announcement backfill skipped: ANNOUNCEMENTS_SYNC_ENABLED is off");
        return 0;
    }
    const { defaultQueue } = await import("../core/queue.js");
    let count = 0;
    let enqueued = 0;
    let cursor: number | undefined;
    for (;;) {
        const page: { id: number }[] = await prisma.broadcast.findMany({
            select: { id: true },
            orderBy: { id: "asc" },
            take: BACKFILL_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;
        for (const { id } of page) {
            const delay = SYNC_DELAY_MS + enqueued * BACKFILL_STAGGER_MS;
            const jobId = `announcement-sync-${id}`;
            const result = await addDebounced(defaultQueue, jobId, id, delay);
            // Задержка растёт только за реально поставленные задачи: уже ждущие не занимают слот.
            if (result === "added") enqueued++;
            if (result === "active") {
                const next = await addDebounced(defaultQueue, `${jobId}-next`, id, delay);
                if (next === "added") enqueued++;
            }
            count++;
        }
        cursor = page[page.length - 1]!.id;
        if (page.length < BACKFILL_PAGE_SIZE) break;
    }
    logger.info({ count }, "Announcement backfill enqueued");
    return count;
}

/** Для мест вызова: отказ очереди/Redis не должен ломать действие пользователя. */
export async function enqueueAnnouncementSyncSafe(broadcastId: number): Promise<void> {
    try {
        await enqueueAnnouncementSync(broadcastId);
    } catch (err) {
        logger.warn({ err, broadcastId }, "Announcement sync enqueue failed");
    }
}

/** Обработчик задачи: свежий снимок и PUT. Ошибка пробрасывается — ретраи BullMQ. */
export async function processAnnouncementSync(broadcastId: number): Promise<void> {
    if (!ANNOUNCEMENTS_SYNC_ENABLED) return;
    const built = await loadSnapshot(broadcastId);
    if (!built) {
        logger.warn({ broadcastId }, "Announcement sync skipped: broadcast not found");
        return;
    }
    await awsBusinessClient.putAnnouncementSnapshot(built.publicId, built.snapshot);
}
