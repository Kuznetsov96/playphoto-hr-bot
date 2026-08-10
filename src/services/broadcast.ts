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
import { TEAM_CHATS, AWS_PREFERENCES_CANONICAL_WRITE_ENABLED } from "../config.js";
import { normalizeCity } from "../handlers/admin/utils.js";
import { redis } from "../core/redis.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import fs from "fs";
import type { BroadcastMediaItem } from "../types/context.js";
import { awsBusinessClient } from "./aws-business-client.js";
import { toCanonicalMonth } from "./preference-month.js";
import { logBusinessEvent } from "../core/log-events.js";

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
}

export interface BroadcastTarget {
    type: 'all' | 'hub' | 'city_chats' | 'city_chat_location' | 'pm_all' | 'pm_city' | 'pm_location' | 'custom_chats';
    value?: string | string[];
}

type BroadcastMediaInput = BroadcastMediaItem | BroadcastMediaItem[];

function buildBroadcastKeyboard(buttonType: 'default' | 'preferences' | 'none', broadcastId?: number, botUsername?: string, isGroup = false) {
    const kb = new InlineKeyboard();

    if (buttonType === 'preferences') {
        kb.text("🗓 Заповнити графік", "pref_fill").row();
        kb.text("🚫 Не буду заповнювати", "pref_opt_out").danger();
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
    if (!AWS_PREFERENCES_CANONICAL_WRITE_ENABLED) return redisFallback;

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

export const broadcastService = {
    async getBroadcastTargetStats(target: BroadcastTarget): Promise<{ chats: number, users: number }> {
        const { chats, users } = await this.resolveTargets(target);
        return { chats: chats.length, users: users.length };
    },

    async sendTestBroadcast(api: any, chatId: number, text: string, media?: BroadcastMediaInput, buttonType: 'default' | 'preferences' | 'none' = 'default') {
        const extra: any = { parse_mode: "HTML" };
        if (buttonType !== 'none') {
            extra.reply_markup = buildBroadcastKeyboard(buttonType);
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
            const allLocs = await locationRepository.findAll();
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

    async createBroadcast(api: any, initiatorId: number, messageText: string, target: BroadcastTarget, media?: BroadcastMediaInput, botUsername?: string, pingOptions?: { initialDelayMs?: number, repeatIntervalMs?: number, buttonType?: 'default' | 'preferences' | 'none' }): Promise<number> {
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
            case 'custom_chats': targetSummary = `💬 Custom Chats (${values.length})`; break;
            default: targetSummary = target.type;
        }

        if ((target.type === 'pm_location' || target.type === 'city_chat_location') && values.length === 1 && values[0]) {
            const loc = await locationRepository.findById(values[0]);
            if (loc) targetSummary = (target.type === 'pm_location' ? "👤 " : "🏘️ ") + `${loc.city} | ${loc.name}`;
        } else if ((target.type === 'pm_location' || target.type === 'city_chat_location') && values.length > 1) {
            const locs = await locationRepository.findAll();
            const filteredLocs = locs.filter(l => values.includes(l.id));
            targetSummary = (target.type === 'pm_location' ? "👤 " : "🏘️ ") + `${filteredLocs.map(l => l.name).join(', ')}`;
        }

        // 1. Create DB Record immediately
        const broadcast = await broadcastRepository.create({
            initiatorId: BigInt(initiatorId),
            messageText: messageText,
            targetSummary: targetSummary
        });
        logToDebug(`✅ [SERVICE] Broadcast created in DB: ${broadcast.id}`);

        // 2. Resolve targets to get a count (optional, but good for UI)
        const { chats, users } = await this.resolveTargets(target);

        // 3. Add to Queue
        const { broadcastQueue } = await import("../core/queue.js");
        try {
            await broadcastQueue.add('send-broadcast', {
                broadcastId: broadcast.id,
                initiatorId,
                messageText,
                target,
                media,
                botUsername,
                pingOptions,
                api: null // API object cannot be serialized, worker must use its own bot instance
            }, {
                jobId: `broadcast-${broadcast.id}`,
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: 500,
                removeOnFail: 1_000,
            });
        } catch (error) {
            await broadcastRepository.update(broadcast.id, { cancelledAt: new Date() }).catch(updateError => {
                logger.error({ err: updateError, broadcastId: broadcast.id }, "Failed to mark unqueued broadcast as cancelled");
            });
            throw error;
        }

        logToDebug(`📥 [SERVICE] Added to queue: ${broadcast.id}`);
        return chats.length + users.length;
    },

    async processBroadcast(jobData: any, botApi: any) {
        const { broadcastId, messageText, target, media, botUsername, pingOptions } = jobData;
        logToDebug(`⚙️ [WORKER] Processing broadcast ${broadcastId}`);

        const { chats, users } = await this.resolveTargets(target);
        logToDebug(`📡 [WORKER] Targets: ${chats.length} chats, ${users.length} users`);

        let sentCount = 0;

        await broadcastDeliveryRepository.createMany([
            ...chats.map(chatId => ({ broadcastId, chatId: BigInt(chatId), targetType: "GROUP" })),
            ...users.map(userId => ({ broadcastId, chatId: BigInt(userId), targetType: "USER" })),
        ]);

        const initialDelay = pingOptions?.initialDelayMs || (20 * 60 * 60 * 1000);
        const repeatInterval = pingOptions?.repeatIntervalMs || null;
        const buttonType = pingOptions?.buttonType || 'default';

        const send = async (chatId: number | bigint, isGroup: boolean) => {
            const numericChatId = Number(chatId);
            const extra: any = { parse_mode: "HTML" };
            if (buttonType !== 'none') {
                extra.reply_markup = buildBroadcastKeyboard(buttonType, broadcastId, botUsername, isGroup);
            }

            return await sendBroadcastPayload(botApi, numericChatId, messageText, media, extra, buttonType);
        };

        for (const chatId of chats) {
            const delivery = await broadcastDeliveryRepository.findUnique(broadcastId, BigInt(chatId));
            if (!delivery || delivery.status !== "PENDING") continue;
            const claimed = await broadcastDeliveryRepository.claimPending(delivery.id);
            if (claimed.count !== 1) continue;

            try {
                const sentMsg = await send(chatId, true);
                if (buttonType !== 'none' && sentMsg) {
                    const tracked = await trackedMessageRepository.create({
                        broadcast: { connect: { id: broadcastId } },
                        chatId: BigInt(chatId),
                        messageId: sentMsg.message_id,
                        nextPingAt: new Date(Date.now() + initialDelay),
                        pingIntervalMs: repeatInterval
                    });
                    await this.populatePendingUsers(tracked.id, chatId, botApi);
                }
                await broadcastDeliveryRepository.markSent(delivery.id, sentMsg?.message_id);
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, chatId }, "Failed to broadcast to chat");
                await broadcastDeliveryRepository.markFailed(delivery.id, e).catch(markError => {
                    logger.error({ err: markError, deliveryId: delivery.id }, "Failed to persist broadcast delivery failure");
                });
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
                    continue;
                }

                const sentMsg = await send(userId, false);
                if (buttonType !== 'none' && sentMsg) {
                    const tracked = await trackedMessageRepository.create({
                        broadcast: { connect: { id: broadcastId } },
                        chatId: BigInt(userId),
                        messageId: sentMsg.message_id,
                        nextPingAt: new Date(Date.now() + initialDelay),
                        pingIntervalMs: repeatInterval
                    });
                    await pendingReplyRepository.create({
                        trackedMessage: { connect: { id: tracked.id } },
                        user: { connect: { telegramId: BigInt(userId) } }
                    });
                }
                await broadcastDeliveryRepository.markSent(delivery.id, sentMsg?.message_id);
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, userId }, "Failed to broadcast to user");
                await broadcastDeliveryRepository.markFailed(delivery.id, e).catch(markError => {
                    logger.error({ err: markError, deliveryId: delivery.id }, "Failed to persist broadcast delivery failure");
                });
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

                const exists = await pendingReplyRepository.findFirst({
                    trackedMessageId,
                    userId: s.user.telegramId
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
            userId: BigInt(userId)
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
            userId: BigInt(userId)
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
    },

    async getStats(broadcastId: number): Promise<BroadcastStats> {
        const [tracked, deliveryStats] = await Promise.all([
            trackedMessageRepository.findManyWithReplies(broadcastId),
            broadcastDeliveryRepository.getStats(broadcastId),
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
        };
    },

    async getRecentBroadcasts(limit = 20) {
        return await broadcastRepository.findRecent(limit);
    },

    async pruneCompletedArchive(keepCompleted: number = 100): Promise<number> {
        if (keepCompleted < 0) keepCompleted = 0;

        const all = await broadcastRepository.findRecent(2000);
        const completed = all.filter((broadcast: any) => {
            const trackedMessages = broadcast.trackedMessages || [];
            const hasActivePings = trackedMessages.some((tracked: any) => Boolean(tracked.nextPingAt));
            if (hasActivePings) return false;
            return !hasPendingReplies(trackedMessages);
        });

        const toDelete = completed.slice(keepCompleted);
        let deletedCount = 0;

        for (const broadcast of toDelete) {
            const trackedIds = (broadcast.trackedMessages || []).map((tracked: any) => tracked.id);
            if (trackedIds.length > 0) {
                await pendingReplyRepository.deleteMany({ trackedMessageId: { in: trackedIds } });
                await trackedMessageRepository.deleteMany({ broadcastId: broadcast.id });
            }
            await broadcastRepository.delete(broadcast.id);
            deletedCount++;
        }

        return deletedCount;
    },

    async stopPinging(broadcastId: number) {
        await trackedMessageRepository.updateMany({ broadcastId }, { nextPingAt: null });
    },

    async stopAllPings(): Promise<number> {
        const result = await trackedMessageRepository.updateMany(
            { nextPingAt: { not: null } },
            { nextPingAt: null }
        );
        return result.count;
    },

    async deleteBroadcast(ctx: MyContext, broadcastId: number) {
        const tracked = await trackedMessageRepository.findManyWithReplies(broadcastId);
        for (const t of tracked) {
            try {
                await ctx.api.deleteMessage(Number(t.chatId), t.messageId);
            } catch (e) { /* ignore */ }
        }

        const trackedIds = tracked.map(t => t.id);
        if (trackedIds.length > 0) {
            await pendingReplyRepository.deleteMany({ trackedMessageId: { in: trackedIds } });
            await trackedMessageRepository.deleteMany({ broadcastId });
        }
        await broadcastRepository.delete(broadcastId);
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
