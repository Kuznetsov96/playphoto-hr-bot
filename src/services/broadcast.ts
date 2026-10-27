import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { staffRepository, type StaffWithRelations } from "../repositories/staff-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { pendingReplyRepository, type PendingReplyWithRelations } from "../repositories/pending-reply-repository.js";
import { broadcastDeliveryRepository } from "../repositories/broadcast-delivery-repository.js";
import { TEAM_CHATS } from "../config.js";
import { normalizeCity } from "../handlers/admin/utils.js";
import { redis } from "../core/redis.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import fs from "fs";
import type { BroadcastMediaItem } from "../types/context.js";
import { awsBusinessClient } from "./aws-business-client.js";
import { collectionCanonicalMonth, firstDayAfterMonth, toCanonicalMonth } from "./preference-month.js";
import { logBusinessEvent } from "../core/log-events.js";
import { formatLocation } from "../utils/location-label.js";
import { enqueueAnnouncementSyncSafe } from "./announcement-sync.js";
import { AnnouncementPartsError, isAttachmentGone, sendAnnouncementParts } from "./announcement-parts.js";

export interface BroadcastStats {
    totalChats: number;
    pending: number;
    confirmed: number;
    declined: number;
    deliveryTotal: number;
    deliverySent: number;
    deliveryFailed: number;
    deliveryUncertain: number;
    deliverySkipped: number;
    /** Когда рассылку сняли из чатов; null — не снималась. */
    withdrawnAt?: Date | null;
    /** Число вложений рассылки (альбом — больше одного). */
    attachmentCount?: number;
}

export interface BroadcastTarget {
    type: 'all' | 'hub' | 'city_chats' | 'city_chat_location' | 'pm_all' | 'pm_city' | 'pm_location' | 'pm_ids' | 'custom_chats';
    value?: string | string[];
}

type BroadcastMediaInput = BroadcastMediaItem | BroadcastMediaItem[];

const toMediaList = (media: BroadcastMediaInput | undefined): BroadcastMediaItem[] =>
    Array.isArray(media) ? media : media ? [media] : [];

/** Вложения рассылки вебаппа (а не файлы, присланные админом боту) идут через sendAnnouncementParts. */
const hasWebappAttachments = (media: BroadcastMediaInput | undefined): boolean =>
    toMediaList(media).some(item => item.attachmentPublicId);

/** Разбор вложений на медиа (фото/видео) и файлы — порядок внутри групп сохраняется. */
const splitAnnouncementMedia = (media: BroadcastMediaInput | undefined) => {
    const items = toMediaList(media);
    return {
        media: items.filter(item => item.type !== 'document'),
        documents: items.filter(item => item.type === 'document'),
    };
};

/**
 * Месяц сбора и предел напоминаний для строки трекинга.
 *
 * Ручная рассылка с кнопкой пожеланий (админка) месяца не передаёт. Без месяца
 * пингер не знает ни срока, ни «сбор закрыт» и напоминал бы вечно — сохранить
 * после закрытия уже нельзя, остановить нечем. Месяц берётся по тому же
 * правилу, что у формы, с пределом в его конце. `pingUntil` из очереди
 * приходит строкой (BullMQ сериализует JSON) — Prisma принимает и её.
 */
export function preferencesPingWindow(
    pingOptions: { buttonType?: string; targetMonth?: string; pingUntil?: Date | string } | undefined,
    now: Date,
): { targetMonth: string | null; pingUntil: Date | string | null } {
    const isPreferences = pingOptions?.buttonType === 'preferences';
    const targetMonth = pingOptions?.targetMonth ?? (isPreferences ? collectionCanonicalMonth(now) : null);
    const pingUntil = pingOptions?.pingUntil
        ?? (isPreferences && targetMonth ? firstDayAfterMonth(targetMonth) : null);
    return { targetMonth, pingUntil };
}

function buildBroadcastKeyboard(buttonType: 'default' | 'preferences' | 'none', broadcastId?: number, botUsername?: string, isGroup = false) {
    const kb = new InlineKeyboard();

    // Одна кнопка, не дві.
    //
    // «🚫 Не буду заповнювати» задумывалась для тех, кто увольняется и не выйдет
    // в следующем месяце. Эту задачу теперь решает `worksUntil`: бэкенд не
    // включает такого человека в `/missing` (schedule-preferences.service.ts),
    // так что напоминания к нему и не приходят, а генератор не ставит ему смены
    // после последнего дня.
    //
    // Без исходного назначения у кнопки осталось лишь одно свойство — она была
    // коротким путём к результату, который форма и так даёт: «Заповнити» →
    // ничего не выбрать → «Готово (0 дн.)» сохраняет пустые пожелания как
    // SUBMITTED и точно так же гасит напоминания. Разница только в записи:
    // кнопка писала DECLINED, из-за чего «я гибкая» и «я ухожу» попадали в одну
    // категорию, а счётчики владельца расходились — заголовок считал такого
    // человека подавшим, а список ожидания не считал.
    if (buttonType === 'preferences') {
        kb.text("🗓 Заповнити графік", "pref_fill");
        return kb;
    }

    if (buttonType === 'default') {
        const okAction = broadcastId ? `broadcast_confirm_ok_${broadcastId}` : "test_confirm_ok";
        kb.text("✅ Ознайомлена", okAction);

        if (broadcastId && isGroup && botUsername) {
            kb.url("❌ Не згодна", `https://t.me/${botUsername}?start=bcq_${broadcastId}`).danger();
        } else {
            const declineAction = broadcastId ? `broadcast_confirm_decline_${broadcastId}` : "test_confirm_decline";
            kb.text("❌ Не згодна", declineAction).danger();
        }
    }

    return kb;
}

function getBroadcastFollowUpText(buttonType: 'default' | 'preferences' | 'none') {
    if (buttonType === 'preferences') {
        return "👇 Обери одну з кнопок нижче, щоб зафіксувати відповідь.";
    }

    if (buttonType === 'default') {
        return "👇 Підтверди ознайомлення або повідом про заперечення кнопкою нижче.";
    }

    return "";
}

async function sendBroadcastPayload(api: any, chatId: number, text: string, media: BroadcastMediaInput | undefined, extra: any, buttonType: 'default' | 'preferences' | 'none') {
    if (Array.isArray(media) && media.length > 1) {
        const canSendAsGroup = media.every(item => item.type === 'photo' || item.type === 'video');
        if (canSendAsGroup) {
            const mediaGroup = media.map(item => ({
                type: item.type,
                media: item.fileId,
            }));
            await api.sendMediaGroup(chatId, mediaGroup);
        } else {
            for (const item of media) {
                if (item.type === 'photo') await api.sendPhoto(chatId, item.fileId);
                else if (item.type === 'video') await api.sendVideo(chatId, item.fileId);
                else if (item.type === 'document') await api.sendDocument(chatId, item.fileId);
                else if (item.type === 'voice') await api.sendVoice(chatId, item.fileId);
                else if (item.type === 'video_note') await api.sendVideoNote(chatId, item.fileId);
                else if (item.type === 'audio') await api.sendAudio(chatId, item.fileId);
                else await api.sendAnimation(chatId, item.fileId);
            }
        }

        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }

        return null;
    }

    const singleMedia = Array.isArray(media) ? media[0] : media;
    if (singleMedia?.type === 'photo') {
        await api.sendPhoto(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'video') {
        await api.sendVideo(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'document') {
        await api.sendDocument(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'voice') {
        await api.sendVoice(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'video_note') {
        await api.sendVideoNote(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'audio') {
        await api.sendAudio(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    if (singleMedia?.type === 'animation') {
        await api.sendAnimation(chatId, singleMedia.fileId);
        if (text || buttonType !== 'none') {
            return await api.sendMessage(chatId, text || getBroadcastFollowUpText(buttonType), extra);
        }
        return null;
    }

    return await api.sendMessage(chatId, text, extra);
}

function isActiveMembership(member: any): boolean {
    if (!member || !member.status) return false;
    if (member.status === "creator" || member.status === "administrator" || member.status === "member") return true;
    if (member.status === "restricted") return member.is_member !== false;
    return false;
}

function hasPendingReplies(trackedMessages: any[]): boolean {
    return trackedMessages.some((tracked) =>
        (tracked.pendingReplies || []).some((reply: any) => reply.status === "pending")
    );
}

/**
 * A user-check function for "has this photographer already filled preferences
 * for this month?" — resolved once per broadcast run, then called once per
 * user, so the canonical branch does a single `/missing` fetch instead of an
 * HTTP call per recipient.
 */
type AlreadyFilledCheck = (userId: number | bigint) => Promise<boolean>;

function redisAlreadyFilledCheck(prefMonthName: string): AlreadyFilledCheck {
    return async (userId) => Boolean(await redis.get(`pref_filled:${userId}:${prefMonthName}`));
}

/**
 * Resolves how to decide "already filled" for this run.
 *
 * Flag OFF → byte-identical to the pre-canonical behaviour: per-user Redis
 * TTL-key reads. Flag ON → a single `/missing` fetch for the month builds
 * the set of telegramIds still missing a submission, alongside a single
 * staff query for which telegramIds are canonically mapped at all. `/missing`
 * only ever lists canonical employees (ACTIVE + telegramId set); a bot user
 * who is not canonically mapped is simply absent from it whether or not they
 * filled anything in, so absence alone cannot mean "filled" for them:
 *
 * - in `/missing` → not filled → send;
 * - canonically mapped and NOT in `/missing` → filled → skip;
 * - NOT canonically mapped → unknown → fall through to the Redis check.
 *
 * If the month can't be converted to YYYY-MM, or the `/missing` fetch fails,
 * this falls back to the Redis check entirely rather than skipping the
 * filter — failing open here would re-pester everyone who already filled in,
 * while falling back to the old approximation is at worst what runs today
 * anyway.
 *
 * `prefMonthYear` must be the calendar year of `prefMonthName`'s month (not
 * necessarily the current year — e.g. a December run targets next month,
 * which is January of the following year).
 */
async function resolveAlreadyFilledCheck(prefMonthName: string, prefMonthYear: number): Promise<AlreadyFilledCheck> {
    const redisFallback = redisAlreadyFilledCheck(prefMonthName);

    const canonicalMonth = toCanonicalMonth(prefMonthName, prefMonthYear);
    if (!canonicalMonth) {
        logBusinessEvent({
            event: "bot.preferences_missing_check.fallback",
            level: "warn",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "PREFERENCE_MONTH_UNRESOLVED",
            module: "broadcast",
            operation: "resolveAlreadyFilledCheck",
            safeContext: {},
        });
        return redisFallback;
    }

    try {
        const [missing, mappedTelegramIds] = await Promise.all([
            awsBusinessClient.missingSchedulePreferences(canonicalMonth),
            staffRepository.findMappedTelegramIds(),
        ]);
        const missingTelegramIds = new Set(missing.items.map((item) => item.telegramId));
        const mappedTelegramIdSet = new Set(mappedTelegramIds);

        return async (userId) => {
            const userIdStr = String(userId);
            if (missingTelegramIds.has(userIdStr)) return false;
            if (mappedTelegramIdSet.has(userIdStr)) return true;
            return redisFallback(userId);
        };
    } catch (error) {
        logBusinessEvent({
            event: "bot.preferences_missing_check.fallback",
            level: "warn",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
            module: "broadcast",
            operation: "resolveAlreadyFilledCheck",
            safeContext: {
                errorType: error instanceof Error ? error.constructor.name : "UnknownError",
            },
        });
        return redisFallback;
    }
}

/** Итог отзыва: сообщения (`deleted`/`failed`) и чаты (`deletedChats`/`stayed` — Telegram id чатов, где что-то осталось). */
export interface WithdrawResult {
    deleted: number;
    failed: number;
    deletedChats: number;
    stayed: string[];
}

export const broadcastService = {
    async getBroadcastTargetStats(target: BroadcastTarget): Promise<{ chats: number, users: number }> {
        const { chats, users } = await this.resolveTargets(target);
        return { chats: chats.length, users: users.length };
    },

    async sendTestBroadcast(api: any, chatId: number, text: string, media?: BroadcastMediaInput, buttonType: 'default' | 'preferences' | 'none' = 'default', textAsCaption = false) {
        const extra: any = { parse_mode: "HTML" };
        if (buttonType !== 'none') {
            extra.reply_markup = buildBroadcastKeyboard(buttonType);
        }

        if (hasWebappAttachments(media)) {
            // Тест не кэширует file_id: файл каждый раз берётся у вебаппа.
            try {
                const result = await sendAnnouncementParts(api, chatId, {
                    text, ...splitAnnouncementMedia(media), textAsCaption, extra, buttonType,
                    fileIds: {},
                    openAttachment: publicId => awsBusinessClient.openAnnouncementAttachment(publicId),
                    followUpText: getBroadcastFollowUpText,
                });
                return result.buttonMessage;
            } catch (error) {
                throw error instanceof AnnouncementPartsError ? (error.cause ?? error) : error;
            }
        }

        return await sendBroadcastPayload(api, chatId, text, media, extra, buttonType);
    },

    async resolveTargets(target: BroadcastTarget) {
        let chats: number[] = [];
        let userIds: bigint[] = [];

        const values = Array.isArray(target.value) ? target.value : (target.value ? [target.value] : []);

        if (target.type === 'all' || target.type === 'hub') {
            chats.push(TEAM_CHATS.HUB);
        }

        if (target.type === 'all' || target.type === 'city_chats' || target.type === 'city_chat_location') {
            // Закриту точку вебапп ховає (isHidden), але її чат лишався в розсилці
            // «по містах» і «всім». Точки, які адмін обрав явно, не фільтруємо.
            const allLocs = (await locationRepository.findAll()).filter(
                l => target.type === 'city_chat_location' || !l.isHidden
            );
            if (target.type === 'city_chats' && values.length > 0) {
                for (const city of values) {
                    const cityLocs = allLocs.filter(l => normalizeCity(l.city) === city && l.telegramChatId);
                    chats.push(...cityLocs.map(l => Number(l.telegramChatId)));
                }
            } else if (target.type === 'city_chat_location' && values.length > 0) {
                const cityLocs = allLocs.filter(l => values.includes(l.id) && l.telegramChatId);
                chats.push(...cityLocs.map(l => Number(l.telegramChatId)));
            } else if (values.length === 0 && target.type !== 'city_chat_location') {
                const cityLocs = allLocs.filter(l => l.telegramChatId);
                chats.push(...cityLocs.map(l => Number(l.telegramChatId)));
            }
        }

        if (target.type === 'custom_chats') {
            chats.push(...values.map(v => Number(v)));
        }

        if (target.type === 'pm_ids') {
            // Явный список Telegram id из вебаппа: каталог сотрудников не нужен.
            for (const v of values) {
                if (/^\d+$/.test(v)) userIds.push(BigInt(v));
            }
            return { chats: [], users: [...new Set(userIds)] };
        }

        const staff = await staffRepository.findActive() as StaffWithRelations[];
        const filteredStaff = staff.filter(s => {
            if (target.type === 'pm_all') return true;
            if (target.type === 'pm_city' && values.length > 0) {
                return s.location?.city && values.includes(normalizeCity(s.location.city));
            }
            if (target.type === 'pm_location' && values.length > 0) {
                return s.locationId && values.includes(s.locationId);
            }
            return false;
        });

        for (const s of filteredStaff) {
            if (s.user?.telegramId) userIds.push(s.user.telegramId);
        }

        return {
            chats: [...new Set(chats)].filter(id => id !== undefined && !isNaN(id)),
            users: [...new Set(userIds)]
        };
    },

    /**
     * Единственное место постановки отправки в очередь. jobId детерминирован
     * (`broadcast-<id>`): повторная постановка живого или недавно завершённого
     * задания BullMQ игнорирует, а если запись уже вычищена, processBroadcast
     * безопасно прогоняется заново (доставки createMany skipDuplicates, не
     * PENDING пропускаются).
     */
    async enqueueBroadcastJob(data: { broadcastId: number } & Record<string, unknown>) {
        const { broadcastQueue } = await import("../core/queue.js");
        await broadcastQueue.add('send-broadcast', {
            ...data,
            api: null // API object cannot be serialized, worker must use its own bot instance
        }, {
            jobId: `broadcast-${data.broadcastId}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: 500,
            removeOnFail: 1_000,
        });
    },

    async createBroadcast(api: any, initiatorId: number, messageText: string, target: BroadcastTarget, media?: BroadcastMediaInput, botUsername?: string, pingOptions?: { initialDelayMs?: number, repeatIntervalMs?: number, buttonType?: 'default' | 'preferences' | 'none', pingUntil?: Date, targetMonth?: string, noReminders?: boolean }, origin?: { publicId?: string, origin?: 'BOT' | 'WEBAPP', authorName?: string, textAsCaption?: boolean }): Promise<number> {
        logToDebug(`🚀 [SERVICE] createBroadcast (Queuing) called by ${initiatorId}`);

        if (!initiatorId && initiatorId !== 0) throw new Error("No user ID");

        let targetSummary = "";
        const values = Array.isArray(target.value) ? target.value : (target.value ? [target.value] : []);
        const valueStr = values.join(', ');

        switch (target.type) {
            case 'all': targetSummary = "🌐 All Teams"; break;
            case 'hub': targetSummary = "🏢 HUB"; break;
            case 'city_chats': targetSummary = values.length > 0 ? `🏘️ ${valueStr}` : "🏘️ All Cities"; break;
            case 'city_chat_location': targetSummary = `🏘️ Chats (ID: ${valueStr})`; break;
            case 'pm_all': targetSummary = "👤 All Staff (PM)"; break;
            case 'pm_city': targetSummary = `👤 City: ${valueStr}`; break;
            case 'pm_location': targetSummary = `👤 Location (ID: ${valueStr})`; break;
            case 'pm_ids': targetSummary = `👤 Recipients (${values.length})`; break;
            case 'custom_chats': targetSummary = `💬 Custom Chats (${values.length})`; break;
            default: targetSummary = target.type;
        }

        if ((target.type === 'pm_location' || target.type === 'city_chat_location') && values.length === 1 && values[0]) {
            const loc = await locationRepository.findById(values[0]);
            if (loc) targetSummary = (target.type === 'pm_location' ? "👤 " : "🏘️ ") + `${loc.city} | ${formatLocation(loc, "in-city")}`;
        } else if ((target.type === 'pm_location' || target.type === 'city_chat_location') && values.length > 1) {
            const locs = await locationRepository.findAll();
            const filteredLocs = locs.filter(l => values.includes(l.id));
            targetSummary = (target.type === 'pm_location' ? "👤 " : "🏘️ ") + `${filteredLocs.map(l => l.name).join(', ')}`;
        }

        // 1. Create DB Record immediately
        const broadcast = await broadcastRepository.create({
            initiatorId: BigInt(initiatorId),
            messageText: messageText,
            targetSummary: targetSummary,
            buttonType: pingOptions?.buttonType ?? 'default',
            attachmentKinds: (Array.isArray(media) ? media : media ? [media] : []).map((item: any) => item.type),
            ...(origin?.publicId ? { publicId: origin.publicId } : {}),
            ...(origin?.origin ? { origin: origin.origin } : {}),
            ...(origin?.authorName ? { authorName: origin.authorName } : {}),
            ...(origin?.textAsCaption ? { textAsCaption: true } : {}),
        });
        logToDebug(`✅ [SERVICE] Broadcast created in DB: ${broadcast.id}`);

        // 2. Resolve targets to get a count (optional, but good for UI)
        const { chats, users } = await this.resolveTargets(target);

        // 3. Add to Queue
        try {
            await this.enqueueBroadcastJob({
                broadcastId: broadcast.id,
                initiatorId,
                messageText,
                target,
                media,
                botUsername,
                pingOptions,
                ...(origin?.textAsCaption ? { textAsCaption: true } : {}),
            });
        } catch (error) {
            if (origin?.publicId) {
                // Команда вебаппа повторится с тем же publicId: «отменённая»
                // строка превратила бы повтор в тихое accepted без отправки.
                await broadcastRepository.delete(broadcast.id).catch(deleteError => {
                    logger.error({ err: deleteError, broadcastId: broadcast.id }, "Failed to remove unqueued webapp broadcast");
                });
            } else {
                await broadcastRepository.update(broadcast.id, { cancelledAt: new Date() }).catch(updateError => {
                    logger.error({ err: updateError, broadcastId: broadcast.id }, "Failed to mark unqueued broadcast as cancelled");
                });
            }
            throw error;
        }

        // Синк — только после постановки в очередь: иначе компенсирующее удаление
        // оставило бы в вебаппе строку DISPATCHED без рассылки.
        await enqueueAnnouncementSyncSafe(broadcast.id);

        logToDebug(`📥 [SERVICE] Added to queue: ${broadcast.id}`);
        return chats.length + users.length;
    },

    async processBroadcast(jobData: any, botApi: any) {
        const { broadcastId, messageText, target, media, botUsername, pingOptions, textAsCaption } = jobData;
        logToDebug(`⚙️ [WORKER] Processing broadcast ${broadcastId}`);

        const { chats, users } = await this.resolveTargets(target);
        logToDebug(`📡 [WORKER] Targets: ${chats.length} chats, ${users.length} users`);

        let sentCount = 0;

        await broadcastDeliveryRepository.createMany([
            ...chats.map(chatId => ({ broadcastId, chatId: BigInt(chatId), targetType: "GROUP" })),
            ...users.map(userId => ({ broadcastId, chatId: BigInt(userId), targetType: "USER" })),
        ]);

        const initialDelay = pingOptions?.initialDelayMs || (20 * 60 * 60 * 1000);
        // Докуда напоминать. Без этого пингер звал бы заполнить форму и после
        // закрытия окна — она отвечает «збір закрито», а он повторяет каждые
        // четыре часа, пока человек не заблокирует бота.
        const buttonType = pingOptions?.buttonType || 'default';
        const { targetMonth, pingUntil } = preferencesPingWindow(pingOptions, new Date());
        const repeatInterval = pingOptions?.repeatIntervalMs || null;

        // Вложения вебаппа: file_id переживает рестарт задачи (лежит в Broadcast.mediaFileIds)
        // и копится в памяти, чтобы второй адресат слал уже по file_id, а не потоком.
        const webappAttachments = hasWebappAttachments(media);
        const fileIds: Record<string, string> = webappAttachments ? await broadcastRepository.getMediaFileIds(broadcastId) : {};
        const rememberFileIds = async (learned: Record<string, string>) => {
            if (Object.keys(learned).length === 0) return;
            Object.assign(fileIds, learned);
            await broadcastRepository.update(broadcastId, { mediaFileIds: { ...fileIds } }).catch(error => {
                logger.error({ err: error, broadcastId }, "Failed to persist announcement media file ids");
            });
        };

        const send = async (chatId: number | bigint, isGroup: boolean): Promise<{ message: any; partMessageIds?: number[] }> => {
            const numericChatId = Number(chatId);
            const extra: any = { parse_mode: "HTML" };
            if (buttonType !== 'none') {
                extra.reply_markup = buildBroadcastKeyboard(buttonType, broadcastId, botUsername, isGroup);
            }

            if (webappAttachments) {
                const result = await sendAnnouncementParts(botApi, numericChatId, {
                    text: messageText ?? "", ...splitAnnouncementMedia(media),
                    textAsCaption: Boolean(textAsCaption), extra, buttonType, fileIds,
                    openAttachment: publicId => awsBusinessClient.openAnnouncementAttachment(publicId),
                    followUpText: getBroadcastFollowUpText,
                }).catch(async error => {
                    if (error instanceof AnnouncementPartsError) await rememberFileIds(error.learnedFileIds);
                    throw error;
                });
                await rememberFileIds(result.learnedFileIds);
                return { message: result.buttonMessage, partMessageIds: result.partMessageIds };
            }

            return { message: await sendBroadcastPayload(botApi, numericChatId, messageText, media, extra, buttonType) };
        };
        // Части, успевшие уйти до сбоя, записываются в доставку; для обычных рассылок аргумента нет.
        const failedParts = (error: unknown): [number[]] | [] =>
            error instanceof AnnouncementPartsError ? [error.partMessageIds] : [];
        // Вложение пропало у вебаппа: остальным ничего не шлём, иначе каждый получит часть рассылки.
        const stopIfAttachmentGone = async (error: unknown) => {
            if (!webappAttachments || !isAttachmentGone(error)) return;
            const failed = await broadcastDeliveryRepository.failPending(broadcastId, "ATTACHMENT_UNAVAILABLE").catch(failError => {
                logger.error({ err: failError, broadcastId }, "Failed to fail pending deliveries of a broadcast with a missing attachment");
                return { count: 0 };
            });
            logBusinessEvent({
                event: "bot.announcement_broadcast.attachment_unavailable",
                level: "error", actorType: "system", actorRole: "system", result: "failed",
                reasonCode: "ATTACHMENT_UNAVAILABLE",
                module: "broadcast", operation: "processBroadcast",
                safeContext: { broadcastId, skippedDeliveries: failed.count },
                error,
            });
        };
        const markSent = (deliveryId: number, sent: { message: any; partMessageIds?: number[] }) =>
            sent.partMessageIds
                ? broadcastDeliveryRepository.markSent(deliveryId, sent.message?.message_id, sent.partMessageIds)
                : broadcastDeliveryRepository.markSent(deliveryId, sent.message?.message_id);

        for (const chatId of chats) {
            const delivery = await broadcastDeliveryRepository.findUnique(broadcastId, BigInt(chatId));
            if (!delivery || delivery.status !== "PENDING") continue;
            const claimed = await broadcastDeliveryRepository.claimPending(delivery.id);
            if (claimed.count !== 1) continue;

            try {
                const sent = await send(chatId, true);
                const sentMsg = sent.message;
                if (buttonType !== 'none' && sentMsg) {
                    const tracked = await trackedMessageRepository.create({
                        broadcast: { connect: { id: broadcastId } },
                        chatId: BigInt(chatId),
                        messageId: sentMsg.message_id,
                        nextPingAt: pingOptions?.noReminders ? null : new Date(Date.now() + initialDelay),
                        pingIntervalMs: repeatInterval,
                        pingUntil,
                        buttonType,
                        targetMonth
                    });
                    await this.populatePendingUsers(tracked.id, chatId, botApi);
                }
                await markSent(delivery.id, sent);
                await enqueueAnnouncementSyncSafe(broadcastId);
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, chatId }, "Failed to broadcast to chat");
                await broadcastDeliveryRepository.markFailed(delivery.id, e, ...failedParts(e)).catch(markError => {
                    logger.error({ err: markError, deliveryId: delivery.id }, "Failed to persist broadcast delivery failure");
                });
                await stopIfAttachmentGone(e);
                await enqueueAnnouncementSyncSafe(broadcastId);
            }
        }

        // For preferences broadcasts, determine the target month to check if users already filled.
        // Resolved once per run (not per user): the canonical branch does a single
        // `/missing` fetch for the whole month rather than one HTTP call per recipient.
        let prefMonthName: string | null = null;
        let alreadyFilledCheck: AlreadyFilledCheck | null = null;
        if (buttonType === 'preferences') {
            const kyivNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
            const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
            prefMonthName = nextMonth.toLocaleString('uk-UA', { month: 'long' });
            alreadyFilledCheck = await resolveAlreadyFilledCheck(prefMonthName, nextMonth.getFullYear());
        }

        for (const userId of users) {
            const delivery = await broadcastDeliveryRepository.findUnique(broadcastId, BigInt(userId));
            if (!delivery || delivery.status !== "PENDING") continue;
            const claimed = await broadcastDeliveryRepository.claimPending(delivery.id);
            if (claimed.count !== 1) continue;

            try {
                // Skip users who already filled preferences for this month (via menu button)
                if (alreadyFilledCheck && await alreadyFilledCheck(userId)) {
                    logger.debug({ userId, month: prefMonthName }, "Preferences broadcast skipped because it was already completed");
                    await broadcastDeliveryRepository.markSkipped(delivery.id, "PREFERENCES_ALREADY_FILLED");
                    await enqueueAnnouncementSyncSafe(broadcastId);
                    continue;
                }

                if (buttonType !== 'none' && target.type === 'pm_ids') {
                    // Получатель из вебаппа может быть неизвестен боту: PendingReply требует User.
                    // Создаём до отправки, чтобы сбой не оставил отправленное сообщение без ответа.
                    await userRepository.upsert({
                        where: { telegramId: BigInt(userId) },
                        create: { telegramId: BigInt(userId) },
                        update: {},
                    });
                }

                const sent = await send(userId, false);
                const sentMsg = sent.message;
                if (buttonType !== 'none' && sentMsg) {
                    const tracked = await trackedMessageRepository.create({
                        broadcast: { connect: { id: broadcastId } },
                        chatId: BigInt(userId),
                        messageId: sentMsg.message_id,
                        nextPingAt: pingOptions?.noReminders ? null : new Date(Date.now() + initialDelay),
                        pingIntervalMs: repeatInterval,
                        pingUntil,
                        buttonType,
                        targetMonth
                    });
                    await pendingReplyRepository.create({
                        trackedMessage: { connect: { id: tracked.id } },
                        user: { connect: { telegramId: BigInt(userId) } }
                    });
                }
                await markSent(delivery.id, sent);
                await enqueueAnnouncementSyncSafe(broadcastId);
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, userId }, "Failed to broadcast to user");
                await broadcastDeliveryRepository.markFailed(delivery.id, e, ...failedParts(e)).catch(markError => {
                    logger.error({ err: markError, deliveryId: delivery.id }, "Failed to persist broadcast delivery failure");
                });
                await stopIfAttachmentGone(e);
                await enqueueAnnouncementSyncSafe(broadcastId);
            }
        }

        const deliveryStats = await broadcastDeliveryRepository.getStats(broadcastId);
        const failedCount = deliveryStats.FAILED || 0;
        const uncertainCount = (deliveryStats.SENDING || 0) + (deliveryStats.PENDING || 0);

        if (failedCount > 0 || uncertainCount > 0) {
            throw new Error(
                `Broadcast ${broadcastId} incomplete: ${failedCount} failed, ${uncertainCount} pending or uncertain`,
            );
        }

        await broadcastRepository.update(broadcastId, { completedAt: new Date() });
        await enqueueAnnouncementSyncSafe(broadcastId);
        logToDebug(`✅ [WORKER] Broadcast ${broadcastId} completed. Sent: ${sentCount}`);
        return sentCount;
    },

    async populatePendingUsers(trackedMessageId: number, chatId: number | bigint, api?: any) {
        const numericChatId = Number(chatId);
        let city: string | undefined;

        const allLocs = await locationRepository.findAll();
        const matchedLoc = allLocs.find(l => Number(l.telegramChatId) === numericChatId);
        if (matchedLoc) {
            city = matchedLoc.city;
        }

        const staff = await staffRepository.findActive() as StaffWithRelations[];
        const filteredStaff = staff.filter(s => {
            if (numericChatId === TEAM_CHATS.HUB) return true;
            // For location/group chats, rely on live membership checks below.
            // This supports staff temporarily working across multiple locations.
            if (numericChatId < 0 && api) return true;
            if (matchedLoc) return s.locationId === matchedLoc.id;
            if (city) return s.location?.city === city;
            return false;
        });

        for (const s of filteredStaff) {
            if (s.user?.telegramId) {
                // For group broadcasts, ping only users who are real members of that chat.
                if (numericChatId < 0 && api) {
                    try {
                        const member = await api.getChatMember(numericChatId, Number(s.user.telegramId));
                        if (!isActiveMembership(member)) continue;
                    } catch (e: any) {
                        const description = String(e?.description || "").toLowerCase();
                        if (
                            e?.error_code === 400 ||
                            description.includes("user not found") ||
                            description.includes("participant_id_invalid") ||
                            description.includes("user not participant")
                        ) {
                            continue;
                        }
                        logger.warn({ err: e, chatId: numericChatId, telegramId: s.user.telegramId }, "Membership probe failed during broadcast pending population");
                        continue;
                    }
                }

                // 'dropped' = снято системой: для рассылки это как будто строки нет.
                const exists = await pendingReplyRepository.findFirst({
                    trackedMessageId,
                    userId: s.user.telegramId,
                    status: { not: "dropped" }
                });
                if (!exists) {
                    await pendingReplyRepository.create({
                        trackedMessage: { connect: { id: trackedMessageId } },
                        user: { connect: { telegramId: s.user.telegramId } }
                    });
                }
            }
        }
    },

    async confirmRead(ctx: MyContext, broadcastId: number): Promise<"confirmed" | "already_confirmed" | "already_declined" | "not_pending"> {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId || !chatId) return "not_pending";

        const tracked = await trackedMessageRepository.findFirst({
            broadcastId: broadcastId,
            chatId: BigInt(chatId)
        });

        if (!tracked) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-not-found"]);
            return "not_pending";
        }

        const pending = await pendingReplyRepository.findFirst({
            trackedMessageId: tracked.id,
            userId: BigInt(userId),
            status: { not: "dropped" }
        });

        if (!pending) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-no-pending-confirm"]);
            return "not_pending";
        }

        if (pending.status === "confirmed") {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-already-confirmed"]);
            return "already_confirmed";
        }

        if (pending.status === "declined") {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-already-declined"]);
            return "already_declined";
        }

        await pendingReplyRepository.update(pending.id, { status: "confirmed", respondedAt: new Date() });
        await enqueueAnnouncementSyncSafe(broadcastId);
        await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-confirmed"]);
        return "confirmed";
    },

    async confirmDecline(ctx: MyContext, broadcastId: number): Promise<"declined" | "already_declined" | "already_confirmed" | "not_pending"> {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        if (!userId || !chatId) return "not_pending";

        const tracked = await trackedMessageRepository.findFirst({
            broadcastId: broadcastId,
            chatId: BigInt(chatId)
        });

        if (!tracked) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-not-found"]);
            return "not_pending";
        }

        const pending = await pendingReplyRepository.findFirst({
            trackedMessageId: tracked.id,
            userId: BigInt(userId),
            status: { not: "dropped" }
        });

        if (!pending) {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-no-pending-decline"]);
            return "not_pending";
        }

        if (pending.status === "declined") {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-already-declined"]);
            return "already_declined";
        }

        if (pending.status === "confirmed") {
            await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-already-confirmed"]);
            return "already_confirmed";
        }

        await pendingReplyRepository.update(pending.id, { status: "declined", respondedAt: new Date() });
        await enqueueAnnouncementSyncSafe(broadcastId);
        await ctx.answerCallbackQuery(STAFF_TEXTS["broadcast-popup-open-decline-form"]);
        return "declined";
    },

    async confirmDeclineByUser(broadcastId: number, userId: number | bigint) {
        const normalizedUserId = BigInt(userId);

        await pendingReplyRepository.updateMany(
            {
                userId: normalizedUserId,
                status: "pending",
                trackedMessage: { broadcastId }
            },
            { status: "declined", respondedAt: new Date() }
        );
        await enqueueAnnouncementSyncSafe(broadcastId);
    },

    async getStats(broadcastId: number): Promise<BroadcastStats> {
        const [tracked, deliveryStats, broadcast] = await Promise.all([
            trackedMessageRepository.findManyWithReplies(broadcastId),
            broadcastDeliveryRepository.getStats(broadcastId),
            broadcastRepository.findById(broadcastId),
        ]);

        let pending = 0;
        let confirmed = 0;
        let declined = 0;

        tracked.forEach(t => {
            t.pendingReplies.forEach(r => {
                if (r.status === 'pending') pending++;
                if (r.status === 'confirmed') confirmed++;
                if (r.status === 'declined') declined++;
            });
        });

        const deliverySent = deliveryStats.SENT || 0;
        const deliveryFailed = deliveryStats.FAILED || 0;
        const deliverySkipped = deliveryStats.SKIPPED || 0;
        const deliveryUncertain = (deliveryStats.SENDING || 0) + (deliveryStats.PENDING || 0);

        return {
            totalChats: tracked.length,
            pending,
            confirmed,
            declined,
            deliveryTotal: deliverySent + deliveryFailed + deliverySkipped + deliveryUncertain,
            deliverySent,
            deliveryFailed,
            deliveryUncertain,
            deliverySkipped,
            withdrawnAt: broadcast?.withdrawnAt ?? null,
            attachmentCount: broadcast?.attachmentKinds?.length ?? 0,
        };
    },

    async getRecentBroadcasts(limit = 20) {
        return await broadcastRepository.findRecent(limit);
    },

    /**
     * Остановка напоминаний. `actorName` — кто нажал в вебаппе (у бота-админа
     * имени нет). Отложенное ручное напоминание отменяется вместе с автоматическими.
     */
    async stopPinging(broadcastId: number, actorName?: string) {
        await broadcastRepository.update(broadcastId, {
            remindersStoppedAt: new Date(),
            ...(actorName ? { remindersStoppedByName: actorName } : {}),
            manualRemindAt: null,
            manualRemindActionId: null,
        });
        await trackedMessageRepository.updateMany({ broadcastId }, { nextPingAt: null });
        await enqueueAnnouncementSyncSafe(broadcastId);
    },

    async stopAllPings(): Promise<number> {
        const affectedIds = await trackedMessageRepository.findBroadcastIdsWithActivePings();
        await broadcastRepository.updateMany(
            { trackedMessages: { some: { nextPingAt: { not: null } } } },
            { remindersStoppedAt: new Date() }
        );
        const result = await trackedMessageRepository.updateMany(
            { nextPingAt: { not: null } },
            { nextPingAt: null }
        );
        for (const id of affectedIds) await enqueueAnnouncementSyncSafe(id);
        return result.count;
    },

    /**
     * «Withdraw»: убрать сообщения из чатов, но оставить историю. Строки не
     * удаляются; рассылка помечается снятой, напоминания останавливаются.
     * Повторный вызов ничего не делает.
     *
     * Удаляются ВСЕ сообщения чата: рассылка, части альбома/вложений
     * (`partMessageIds`, в них же переподтверждения), последнее напоминание.
     * Чат «остался», если не удалось убрать хотя бы одно из его сообщений
     * (Telegram не удаляет сообщения старше 48 часов).
     * `actor`: Telegram id админа бота или имя из вебаппа.
     */
    async withdrawBroadcast(
        api: any,
        broadcastId: number,
        actor: number | bigint | { name: string },
    ): Promise<WithdrawResult> {
        const byName = typeof actor === "object" && actor !== null && "name" in actor;
        // Атомарный захват: параллельные вызовы не удалят сообщения дважды.
        const claim = await broadcastRepository.updateMany(
            { id: broadcastId, withdrawnAt: null },
            {
                withdrawnAt: new Date(),
                ...(byName ? { withdrawnByName: actor.name } : { withdrawnByTelegramId: BigInt(actor as number | bigint) }),
                manualRemindAt: null,
                manualRemindActionId: null,
            },
        );
        if (claim.count === 0) return { deleted: 0, failed: 0, deletedChats: 0, stayed: [] };

        const [tracked, deliveries] = await Promise.all([
            trackedMessageRepository.findManyWithReplies(broadcastId),
            broadcastDeliveryRepository.findSentMessages(broadcastId),
        ]);

        const byChat = new Map<string, { chatId: number; messageIds: Set<number> }>();
        const add = (chatId: bigint, messageId: number | null | undefined) => {
            if (messageId == null) return;
            const key = String(chatId);
            const entry = byChat.get(key) ?? { chatId: Number(chatId), messageIds: new Set<number>() };
            entry.messageIds.add(messageId);
            byChat.set(key, entry);
        };
        for (const t of tracked) {
            add(t.chatId, t.messageId);
            add(t.chatId, t.lastPingMsgId);
        }
        for (const d of deliveries) {
            add(d.chatId, d.messageId);
            for (const id of d.partMessageIds ?? []) add(d.chatId, id);
        }

        let deleted = 0;
        let failed = 0;
        let deletedChats = 0;
        const stayed: string[] = [];
        for (const [key, { chatId, messageIds }] of byChat) {
            let chatFailed = false;
            for (const messageId of messageIds) {
                try {
                    await api.deleteMessage(chatId, messageId);
                    deleted++;
                } catch (e: any) {
                    // Уже удалено руками — сообщения в чате и так нет.
                    if (/message to delete not found/iu.test(String(e?.description ?? ""))) {
                        deleted++;
                        continue;
                    }
                    // Старше 48 часов или нет прав — Telegram не даст убрать.
                    failed++;
                    chatFailed = true;
                }
            }
            if (chatFailed) stayed.push(key); else deletedChats++;
        }

        await trackedMessageRepository.updateMany({ broadcastId }, { nextPingAt: null });
        await enqueueAnnouncementSyncSafe(broadcastId);

        return { deleted, failed, deletedChats, stayed };
    },

    async getPendingUsers(broadcastId: number): Promise<string[]> {
        const pending = await pendingReplyRepository.findMany(
            { trackedMessage: { broadcastId }, status: 'pending' }
        );

        return pending.map(p => {
            const name = p.user.staffProfile?.fullName || p.user.firstName || "Unknown";
            const username = p.user.username ? `@${p.user.username}` : `(ID: ${p.userId})`;
            return `${name} ${username}`;
        });
    },

    async getFullStatusReport(broadcastId: number) {
        const tracked = await trackedMessageRepository.findManyWithReplies(broadcastId);

        const confirmed: string[] = [];
        const declined: string[] = [];
        const pending: string[] = [];

        for (const t of tracked) {
            for (const r of t.pendingReplies) {
                const user = await userRepository.findWithStaffProfileByTelegramId(r.userId);
                const name = user?.staffProfile?.fullName || user?.firstName || `ID: ${r.userId}`;
                const entry = `• ${name}${user?.username ? ` (@${user.username})` : ''}`;

                if (r.status === 'confirmed') confirmed.push(entry);
                else if (r.status === 'declined') declined.push(entry);
                else if (r.status === 'pending') pending.push(entry);
            }
        }

        return {
            confirmed: [...new Set(confirmed)].sort(),
            declined: [...new Set(declined)].sort(),
            pending: [...new Set(pending)].sort()
        };
    }
};

function logToDebug(msg: string) {
    console.log(msg);
    // logger.debug({ msg }, "Broadcast Service Debug Log");
}
