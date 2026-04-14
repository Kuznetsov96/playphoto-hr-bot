import { InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import logger from "../core/logger.js";
import { staffRepository, type StaffWithRelations } from "../repositories/staff-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { pendingReplyRepository, type PendingReplyWithRelations } from "../repositories/pending-reply-repository.js";
import { TEAM_CHATS } from "../config.js";
import { normalizeCity } from "../handlers/admin/utils.js";
import { redis } from "../core/redis.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import fs from "fs";
import type { BroadcastMediaItem } from "../types/context.js";

interface BroadcastStats {
    totalChats: number;
    pending: number;
    confirmed: number;
    declined: number;
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
        kb.text("🚫 Не буду заповнювати", "pref_opt_out");
        return kb;
    }

    if (buttonType === 'default') {
        const okAction = broadcastId ? `broadcast_confirm_ok_${broadcastId}` : "test_confirm_ok";
        kb.text("✅ Ознайомлена", okAction);

        if (broadcastId && isGroup && botUsername) {
            kb.url("❌ Не згодна", `https://t.me/${botUsername}?start=bcq_${broadcastId}`);
        } else {
            const declineAction = broadcastId ? `broadcast_confirm_decline_${broadcastId}` : "test_confirm_decline";
            kb.text("❌ Не згодна", declineAction);
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
        const mediaGroup = media.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            ...(index === 0 ? { caption: text, parse_mode: "HTML" as const } : {})
        }));

        await api.sendMediaGroup(chatId, mediaGroup);

        if (buttonType !== 'none') {
            return await api.sendMessage(chatId, getBroadcastFollowUpText(buttonType), extra);
        }

        return null;
    }

    const singleMedia = Array.isArray(media) ? media[0] : media;
    if (singleMedia?.type === 'photo') {
        return await api.sendPhoto(chatId, singleMedia.fileId, { caption: text, ...extra });
    }

    if (singleMedia?.type === 'video') {
        return await api.sendVideo(chatId, singleMedia.fileId, { caption: text, ...extra });
    }

    return await api.sendMessage(chatId, text, extra);
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
                    const cityLocs = allLocs.filter(l => l.city === city && l.telegramChatId);
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
        await broadcastQueue.add('send-broadcast', {
            broadcastId: broadcast.id,
            initiatorId,
            messageText,
            target,
            media,
            botUsername,
            pingOptions,
            api: null // API object cannot be serialized, worker must use its own bot instance
        });

        logToDebug(`📥 [SERVICE] Added to queue: ${broadcast.id}`);
        return chats.length + users.length;
    },

    async processBroadcast(jobData: any, botApi: any) {
        const { broadcastId, messageText, target, media, botUsername, pingOptions } = jobData;
        logToDebug(`⚙️ [WORKER] Processing broadcast ${broadcastId}`);

        const { chats, users } = await this.resolveTargets(target);
        logToDebug(`📡 [WORKER] Targets: ${chats.length} chats, ${users.length} users`);

        let sentCount = 0;

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
            try {
                const sentMsg = await send(chatId, true);
                if (buttonType !== 'none' && sentMsg) {
                    const tracked = await trackedMessageRepository.create({
                        broadcast: { connect: { id: broadcastId } },
                        chatId: BigInt(chatId),
                        messageId: sentMsg.message_id,
                        nextPingAt: new Date(Date.now() + 20 * 60 * 60 * 1000)
                    });
                    await this.populatePendingUsers(tracked.id, chatId);
                }
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, chatId }, "Failed to broadcast to chat");
            }
        }

        // For preferences broadcasts, determine the target month to check if users already filled
        let prefMonthName: string | null = null;
        if (buttonType === 'preferences') {
            const kyivNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
            const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
            prefMonthName = nextMonth.toLocaleString('uk-UA', { month: 'long' });
        }

        for (const userId of users) {
            try {
                // Skip users who already filled preferences for this month (via menu button)
                if (prefMonthName) {
                    const alreadyFilled = await redis.get(`pref_filled:${userId}:${prefMonthName}`);
                    if (alreadyFilled) {
                        logger.debug({ userId, month: prefMonthName }, "Preferences broadcast skipped because it was already completed");
                        continue;
                    }
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
                sentCount++;
            } catch (e: any) {
                logger.error({ err: e, userId }, "Failed to broadcast to user");
            }
        }

        logToDebug(`✅ [WORKER] Broadcast ${broadcastId} completed. Sent: ${sentCount}`);
        return sentCount;
    },

    async populatePendingUsers(trackedMessageId: number, chatId: number | bigint) {
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
            if (matchedLoc) return s.locationId === matchedLoc.id;
            if (city) return s.location?.city === city;
            return false;
        });

        for (const s of filteredStaff) {
            if (s.user?.telegramId) {
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
        const tracked = await trackedMessageRepository.findManyWithReplies(broadcastId);

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

        return { totalChats: tracked.length, pending, confirmed, declined };
    },

    async getRecentBroadcasts(limit = 20) {
        return await broadcastRepository.findRecent(limit);
    },

    async stopPinging(broadcastId: number) {
        await trackedMessageRepository.updateMany({ broadcastId }, { nextPingAt: null });
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
