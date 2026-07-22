import { Composer, InlineKeyboard } from "grammy";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { broadcastService } from "../../services/broadcast.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { getMessageHtml, normalizeCity } from "./utils.js";
import { getBroadcastKb, getBroadcastPreview, formatTargetLabel } from "./broadcast-helpers.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import logger from "../../core/logger.js";
import { audit } from "../../core/audit-logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import type { BroadcastMediaItem } from "../../types/context.js";
import { getRichMessageMedia } from "../../utils/rich-message.js";

export const adminBroadcastHandlers = new Composer<MyContext>();
const ARCHIVE_KEEP_COMPLETED = 50;
const ARCHIVE_PAGE_SIZE = 8;

// --- MENUS (Declared first to avoid cycles) ---
export const adminBroadcastHubMenu = new Menu<MyContext>("admin-broadcast-hub");
export const adminBroadcastListMenu = new Menu<MyContext>("admin-broadcast-list");
export const adminBroadcastArchiveMenu = new Menu<MyContext>("admin-broadcast-archive");
export const adminBroadcastManageMenu = new Menu<MyContext>("admin-broadcast-manage");
const TELEGRAM_MESSAGE_LIMIT = 4096;

function getPendingCount(broadcast: any): number {
    return broadcast.trackedMessages?.reduce((acc: number, tracked: any) =>
        acc + (tracked.pendingReplies?.filter((reply: any) => reply.status === "pending").length || 0), 0) || 0;
}

function isBroadcastActive(broadcast: any): boolean {
    const hasActivePing = broadcast.trackedMessages?.some((tracked: any) => Boolean(tracked.nextPingAt)) || false;
    return hasActivePing || getPendingCount(broadcast) > 0;
}

/**
 * Entry point from the menu
 */
export async function startStatelessBroadcast(ctx: MyContext) {
    ctx.session.adminFlow = 'BROADCAST';
    ctx.session.step = "idle";
    ctx.session.candidateData = {};
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.broadcastDraft;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
    ctx.session.broadcastData = {
        step: 'SELECT_TARGET',
        selectedLocs: []
    } as any;

    await renderTargetSelection(ctx);
}

async function renderTargetSelection(ctx: MyContext) {
    const kb = new InlineKeyboard()
        .text("🌐 All Teams Chats", "br_type_all").row()
        .text("🏢 HUB Only", "br_type_hub").row()
        .text("🏘️ City Chats", "br_type_city_chats").row()
        .text("👤 PM: All Staff", "br_type_pm_all").row()
        .text("👤 PM: By Cities", "br_type_pm_city").row()
        .text("✖️ Cancel", "br_cancel").danger();

    const text = "📢 <b>BROADCAST:</b> Select recipients:";
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

/**
 * Handle Target Type Selection
 */
adminBroadcastHandlers.callbackQuery(/^br_type_(.+)$/, async (ctx) => {
    const type = ctx.match![1] as any;
    if (!ctx.session.broadcastData) return ctx.answerCallbackQuery("Session expired.").catch(() => { });

    ctx.session.broadcastData.targetType = type;

    if (type === 'city_chats' || type === 'pm_city') {
        ctx.session.broadcastData.step = 'SELECT_TARGET';
        await renderCitySelection(ctx);
    } else {
        ctx.session.broadcastData.step = 'SELECT_BUTTONS';
        await renderButtonSelection(ctx);
    }
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderButtonSelection(ctx: MyContext) {
    const kb = new InlineKeyboard()
        .text("✅ Default (Confirm/Decline)", "br_btn_default").row()
        .text("🗓 Preferences (Fill/Opt-out)", "br_btn_preferences").row()
        .text("🔕 None (Simple Message)", "br_btn_none").row()
        .text("⬅️ Back", "br_back_to_main");

    await ScreenManager.renderScreen(ctx, "🔘 <b>Select button types for this broadcast:</b>", kb, { pushToStack: true });
}

adminBroadcastHandlers.callbackQuery(/^br_btn_(.+)$/, async (ctx) => {
    const type = ctx.match![1] as any;
    if (!ctx.session.broadcastData) return;

    ctx.session.broadcastData.buttonType = type;
    ctx.session.broadcastData.step = 'AWAITING_CONTENT';
    await renderContentPrompt(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

/**
 * City Selection (Multi-select)
 */
export async function renderCitySelection(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const rawCities = await locationRepository.findAllCities();
    const allCities = Array.from(new Set(rawCities.map(normalizeCity))).sort();
    const selected = new Set(data.targetValue as string[] || []);

    const kb = new InlineKeyboard();
    allCities.forEach(city => {
        const label = selected.has(city) ? `✅ ${city}` : `⬜ ${city}`;
        kb.text(label, `br_toggle_city_${city}`).row();
    });

    if (selected.size > 0) {
        kb.text(`➡️ Continue (${selected.size})`, "br_confirm_cities").row();
    }

    kb.text(selected.size === allCities.length ? "⬜ Unselect All" : "✅ Select All", "br_toggle_all_cities");
    kb.text("⬅️ Back", "br_back_to_main").row();

    await ScreenManager.renderScreen(ctx, "🏘️ <b>Select cities:</b>", kb);
}

adminBroadcastHandlers.callbackQuery(/^br_toggle_city_(.+)$/, async (ctx) => {
    const city = ctx.match![1]!;
    if (!ctx.session.broadcastData) return;

    const selected = new Set(ctx.session.broadcastData.targetValue as string[] || []);
    if (selected.has(city)) selected.delete(city);
    else selected.add(city);

    ctx.session.broadcastData.targetValue = Array.from(selected);
    await renderCitySelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_toggle_all_cities", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    const rawCities = await locationRepository.findAllCities();
    const allCities = Array.from(new Set(rawCities.map(normalizeCity)));

    const selected = new Set(ctx.session.broadcastData.targetValue as string[] || []);
    if (selected.size === allCities.length) {
        ctx.session.broadcastData.targetValue = [];
    } else {
        ctx.session.broadcastData.targetValue = allCities;
    }

    await renderCitySelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_confirm_cities", async (ctx) => {
    if (!ctx.session.broadcastData) return;

    const type = ctx.session.broadcastData.targetType;
    const selectedCities = (ctx.session.broadcastData.targetValue as string[] || []);
    if (type === 'pm_city' || type === 'city_chats') {
        const allLocs = await locationRepository.findAllActive();
        const cityLocs = allLocs.filter((l) => selectedCities.includes(normalizeCity(l.city)));

        if (type === 'city_chats') {
            const chatCount = new Set(cityLocs.filter((l) => l.telegramChatId).map((l) => String(l.telegramChatId))).size;
            if (chatCount <= 1) {
                ctx.session.broadcastData.step = 'SELECT_BUTTONS';
                await renderButtonSelection(ctx);
                await ctx.answerCallbackQuery().catch(() => { });
                return;
            }
        }

        if (type === 'pm_city' && cityLocs.length <= 1) {
            ctx.session.broadcastData.step = 'SELECT_BUTTONS';
            await renderButtonSelection(ctx);
            await ctx.answerCallbackQuery().catch(() => { });
            return;
        }

        const kb = new InlineKeyboard()
            .text("📢 Everyone in these cities", "br_scope_all").row()
            .text("📍 Choose specific locations", "br_scope_locs").row()
            .text("⬅️ Back", `br_type_${type}`);

        const label = type === 'pm_city' ? "everyone" : "all group chats";
        await ScreenManager.renderScreen(ctx, `👥 Cities selected. Send to ${label} or filter by location?`, kb);
    } else {
        ctx.session.broadcastData.step = 'SELECT_BUTTONS';
        await renderButtonSelection(ctx);
    }
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_scope_all", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    ctx.session.broadcastData.step = 'SELECT_BUTTONS';
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_scope_locs", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    const currentType = ctx.session.broadcastData.targetType;
    ctx.session.broadcastData.targetType = currentType === 'pm_city' ? 'pm_location' : 'city_chat_location';
    await renderLocationSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderLocationSelection(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const cities = data.targetValue as string[];
    const allLocs = await locationRepository.findAllActive();
    let filteredLocs = allLocs.filter(l => cities.includes(normalizeCity(l.city)));

    // For group chats, only show locations that actually have a chat ID configured
    if (data.targetType === 'city_chat_location') {
        filteredLocs = filteredLocs.filter(l => l.telegramChatId);
    }

    const selected = new Set(data.selectedLocs || []);

    const kb = new InlineKeyboard();
    filteredLocs.forEach(l => {
        const label = selected.has(l.id) ? `✅ ${l.name}` : `⬜ ${l.name}`;
        kb.text(label, `br_toggle_loc_${l.id}`).row();
    });

    if (selected.size > 0) {
        kb.text(`➡️ Continue (${selected.size})`, "br_confirm_locs").row();
    }
    kb.text("⬅️ Back", "br_confirm_cities");

    const targetLabel = data.targetType === 'city_chat_location' ? "group chats" : "locations";
    await ScreenManager.renderScreen(ctx, `📍 <b>Select ${targetLabel}:</b>`, kb);
}

adminBroadcastHandlers.callbackQuery(/^br_toggle_loc_(.+)$/, async (ctx) => {
    const locId = ctx.match![1]!;
    if (!ctx.session.broadcastData) return;

    const selected = new Set(ctx.session.broadcastData.selectedLocs || []);
    if (selected.has(locId)) selected.delete(locId);
    else selected.add(locId);

    ctx.session.broadcastData.selectedLocs = Array.from(selected);
    await renderLocationSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_confirm_locs", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    ctx.session.broadcastData.targetValue = ctx.session.broadcastData.selectedLocs || [];
    ctx.session.broadcastData.step = 'SELECT_BUTTONS';
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderContentPrompt(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const targetLabel = formatTargetLabel(data.targetType!);
    const text = `📢 <b>Broadcast Content</b>\nTarget: <b>${targetLabel}</b>\nButtons: <code>${data.buttonType || 'default'}</code>\n\n` +
        `👇 <b>Please send the message now.</b>\n` +
        `It can be text, one media file, or one/multiple photos with a caption.\n` +
        `For photo collections, send all photos and then tap Continue.\n\n` +
        `<i>Formatting (bold, links, etc.) will be preserved.</i>`;

    const kb = new InlineKeyboard().text("⬅️ Back", "br_confirm_buttons").text("✖️ Cancel", "br_cancel").danger();
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

async function renderMediaCollectionPrompt(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const mediaItems = data.mediaItems || [];
    const photoCount = mediaItems.filter((item) => item.type === 'photo').length;
    const hasCaption = Boolean(data.text);

    const text = `🖼 <b>Photos added to broadcast</b>\n\n` +
        `Photos queued: <b>${photoCount}</b>\n` +
        `Caption captured: <b>${hasCaption ? 'yes' : 'no'}</b>\n\n` +
        `Send more photos if needed, then tap Continue.`;

    const kb = new InlineKeyboard()
        .text(`➡️ Continue (${photoCount})`, "br_media_continue").row()
        .text("🗑 Clear Photos", "br_media_reset").row()
        .text("⬅️ Back", "br_confirm_buttons")
        .text("✖️ Cancel", "br_cancel").danger();

    await ScreenManager.renderScreen(ctx, text, kb, { forceNew: true });
}

function getBroadcastMediaItems(data: NonNullable<MyContext['session']['broadcastData']>): BroadcastMediaItem[] {
    if (data.mediaItems?.length) return data.mediaItems;
    if (data.media) return [data.media];
    return [];
}

function getMediaSummary(mediaItems: BroadcastMediaItem[]): string {
    if (mediaItems.length === 0) return '';

    if (mediaItems.length === 1) {
        const type = mediaItems[0]!.type;
        const labels: Record<BroadcastMediaItem["type"], string> = {
            photo: "photo",
            video: "video",
            document: "document",
            voice: "voice message",
            video_note: "video note",
            audio: "audio",
            animation: "GIF",
        };
        return `📎 <b>Attachment:</b> 1 ${labels[type]}`;
    }

    return `🖼 <b>Attachments:</b> ${mediaItems.length} photos`;
}

function getMediaSuccessSummary(mediaItems: BroadcastMediaItem[]): string {
    if (mediaItems.length === 0) return '';

    if (mediaItems.length === 1) {
        const type = mediaItems[0]!.type;
        const labels: Record<BroadcastMediaItem["type"], string> = {
            photo: "photo",
            video: "video",
            document: "document",
            voice: "voice message",
            video_note: "video note",
            audio: "audio",
            animation: "GIF",
        };
        return `📎 Attachment: 1 ${labels[type]}`;
    }

    const photoCount = mediaItems.filter((item) => item.type === 'photo').length;
    if (photoCount === mediaItems.length) {
        return `🖼 Attachments: ${photoCount} photos`;
    }

    return `📎 Attachments: ${mediaItems.length} files`;
}

adminBroadcastHandlers.callbackQuery("br_confirm_buttons", async (ctx) => {
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

export async function handleBroadcastContent(ctx: MyContext) {
    if (!ctx.session.broadcastData) return false;
    if (ctx.session.adminFlow !== 'BROADCAST') return false;
    if (ctx.session.broadcastData.step !== 'AWAITING_CONTENT' && ctx.session.broadcastData.step !== 'CONFIRMATION') return false;
    if (ctx.chat?.type !== "private") return false;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    if (!hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT')) return false;

    const message = ctx.message;
    if (!message) return false;

    const data = ctx.session.broadcastData;
    if (data.step === 'CONFIRMATION') {
        delete ctx.session.broadcastDraft;
        delete data.media;
        delete data.mediaItems;
        delete data.text;
    }

    let media: BroadcastMediaItem | undefined;
    if (message.photo) media = { type: 'photo', fileId: message.photo[message.photo.length - 1]!.file_id };
    else if (message.video) media = { type: 'video', fileId: message.video.file_id };
    else if (message.document) media = { type: 'document', fileId: message.document.file_id };
    else if (message.voice) media = { type: 'voice', fileId: message.voice.file_id };
    else if (message.video_note) media = { type: 'video_note', fileId: message.video_note.file_id };
    else if (message.audio) media = { type: 'audio', fileId: message.audio.file_id };
    else if (message.animation) media = { type: 'animation', fileId: message.animation.file_id };

    const richMediaItems = getRichMessageMedia(message.rich_message);
    if (!media && richMediaItems.length === 1) media = richMediaItems[0];

    const textHtml = getMessageHtml(message);

    if (!textHtml && !media) {
        await ctx.reply("❌ Please send some content (text or media).");
        return true;
    }

    if (textHtml) {
        if (textHtml.length > TELEGRAM_MESSAGE_LIMIT) {
            await ctx.reply(
                `❌ Broadcast text is too long: ${textHtml.length}/${TELEGRAM_MESSAGE_LIMIT} characters.\n\n` +
                `Please shorten it or split it into multiple broadcasts. This broadcast was not queued.`
            );
            return true;
        }
        data.text = textHtml;
    }

    if (!media && richMediaItems.length > 1) {
        data.mediaItems = richMediaItems;
        delete data.media;
        data.step = 'CONFIRMATION';
        try { await ctx.deleteMessage(); } catch { }
        await renderReview(ctx);
        return true;
    }

    if (media && media.type !== 'photo') {
        if ((data.mediaItems || []).length > 0) {
            await ctx.reply("❌ This media type cannot be combined with a photo set. Clear photos or restart the broadcast.");
            return true;
        }

        data.media = media;
        delete data.mediaItems;
        data.step = 'CONFIRMATION';

        try { await ctx.deleteMessage(); } catch { }
        await renderReview(ctx);
        return true;
    }

    if (media?.type === 'photo') {
        if (data.media?.type === 'video') {
            await ctx.reply("❌ Photos cannot be added after a video. Restart the broadcast to change media type.");
            return true;
        }

        const mediaItems = getBroadcastMediaItems(data).filter((item) => item.type === 'photo');
        mediaItems.push(media);
        data.mediaItems = mediaItems;
        delete data.media;

        try { await ctx.deleteMessage(); } catch { }
        await renderMediaCollectionPrompt(ctx);
        return true;
    }

    data.step = 'CONFIRMATION';

    try { await ctx.deleteMessage(); } catch { }

    await renderReview(ctx);
    return true;
}

adminBroadcastHandlers.callbackQuery("br_media_reset", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });

    delete data.media;
    delete data.mediaItems;
    delete data.text;
    await renderContentPrompt(ctx);
    await ctx.answerCallbackQuery("Photos cleared.").catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_media_continue", async (ctx) => {
    const data = ctx.session.broadcastData;
    if (!data) return ctx.answerCallbackQuery("Session expired.").catch(() => { });

    const mediaItems = getBroadcastMediaItems(data);
    if (mediaItems.length === 0) {
        await ctx.answerCallbackQuery("Add at least one photo first.").catch(() => { });
        return;
    }

    data.step = 'CONFIRMATION';
    await renderReview(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

async function renderReview(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const stats = await broadcastService.getBroadcastTargetStats({
        type: data.targetType as any,
        value: data.targetValue || []
    });
    const mediaItems = getBroadcastMediaItems(data);
    const mediaSummary = getMediaSummary(mediaItems);
    const preview = getBroadcastPreview(data.text || "", data.targetType as any, stats, false, false, data.buttonType || 'default', mediaSummary);
    if (preview.length > TELEGRAM_MESSAGE_LIMIT) {
        data.step = 'AWAITING_CONTENT';
        delete ctx.session.broadcastDraft;
        await ctx.reply(
            `❌ Broadcast preview is too long: ${preview.length}/${TELEGRAM_MESSAGE_LIMIT} characters.\n\n` +
            `The message itself may fit, but the preview adds target/button details. Please shorten the message a little or split it into multiple broadcasts. This broadcast was not queued.`
        );
        return;
    }

    const kb = getBroadcastKb(false, false, stats);

    kb.row().text("🔄 Start Over", "br_restart").text("✖️ Cancel", "br_cancel").danger();

    ctx.session.broadcastDraft = {
        textHtml: data.text || "",
        targetType: data.targetType as any,
        targetStats: stats,
        confirmChatId: ctx.chat!.id,
        buttonType: data.buttonType as any
    };
    if (mediaItems.length === 1) ctx.session.broadcastDraft.media = mediaItems[0];
    if (mediaItems.length > 1) ctx.session.broadcastDraft.media = mediaItems;
    (ctx.session as any).broadcastValue = data.targetValue;
    try {
        const msg = await ctx.reply(preview, { parse_mode: "HTML", reply_markup: kb });
        data.menuMessageId = msg.message_id;
    } catch (e: any) {
        logger.error({ err: e }, "Broadcast preview failed");
        data.step = 'AWAITING_CONTENT';
        delete ctx.session.broadcastDraft;
        await ctx.reply(
            `❌ Broadcast preview failed: ${e.message}\n\n` +
            `The broadcast was not queued. Please remove unusual formatting or split the message, then send it again.`
        );
    }
}

adminBroadcastHandlers.callbackQuery("br_cancel", async (ctx) => {
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    if (ctx.session.adminFlow === "BROADCAST") {
        delete ctx.session.adminFlow;
    }
    await ctx.answerCallbackQuery("❌ Cancelled.").catch(() => { });
    await ScreenManager.renderScreen(ctx, "❌ Broadcast creation cancelled.", new InlineKeyboard().text("🏠 Back to Hub", "br_to_hub"));
});

adminBroadcastHandlers.callbackQuery("br_restart", async (ctx) => {
    await startStatelessBroadcast(ctx);
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_to_hub", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_back_to_main", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery().catch(() => { });
});

// --- MENU IMPLEMENTATIONS ---

adminBroadcastListMenu.dynamic(async (ctx, range) => {
    const broadcasts = await broadcastService.getRecentBroadcasts(100);
    const activeBroadcasts = broadcasts.filter((broadcast: any) => isBroadcastActive(broadcast)).slice(0, 10);

    if (activeBroadcasts.length === 0) {
        range.text("✅ No active pings", (ctx) => ctx.answerCallbackQuery().catch(() => { })).row();
    }
    else {
        activeBroadcasts.forEach((b: any) => {
            const date = new Date(b.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
            const pending = getPendingCount(b);
            const label = `🔔 ${date} #${b.id} | ⏳${pending} | ${b.targetSummary || 'Broadcast'}`;

            range.text(label, async (ctx) => {
                if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
                ctx.session.candidateData.city = b.id.toString();

                const stats = await broadcastService.getStats(b.id);
                const statsText = `📊 <b>Broadcast Statistics (ID: ${b.id})</b>\n\n` +
                    `🌐 Total chats: <b>${stats.totalChats}</b>\n` +
                    `✅ Confirmed: <b>${stats.confirmed}</b>\n` +
                    `❌ Declined: <b>${stats.declined}</b>\n` +
                    `⏳ Pending: <b>${stats.pending}</b>\n\n` +
                    `<i>Last updated: ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</i>`;

                await ScreenManager.renderScreen(ctx, statsText, "admin-broadcast-manage", { pushToStack: true });
            }).row();
        });
    }

    range.text("🗂 Completed Archive", async (ctx) => {
        (ctx.session as any).broadcastArchivePage = 0;
        await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive", { pushToStack: true });
    }).row();

    range.text("⏹ Stop All Active Pings", async (ctx) => {
        const confirmKb = new InlineKeyboard()
            .text("✅ Yes, stop all", "br_stop_all_pings_exec").danger().row()
            .text("✖️ Cancel", "br_stop_all_pings_cancel").danger();

        await ScreenManager.renderScreen(
            ctx,
            "⚠️ <b>Stop all active pings?</b>\n\nThis will disable auto-repeat for every current broadcast.",
            confirmKb,
            { pushToStack: true }
        );
    }).row()
        .text("⬅️ Back", async (ctx) => {
            await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
        });
});

adminBroadcastHubMenu.dynamic(async (ctx, range) => {
    range.text("📢 New Broadcast", async (ctx) => {
        if (ctx.session) {
            try {
                delete ctx.session.broadcastDraft;
                delete ctx.session.broadcastData;
            } catch (e) { }
            ctx.session.broadcastTestConfirmed = false;
        }
        await startStatelessBroadcast(ctx);
    }).row();

    range.text("📜 Active / Manage", async (ctx) => {
        await ScreenManager.renderScreen(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list", { pushToStack: true });
    }).row();
    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "🛠️ <b>System Settings</b>", "admin-system");
    });
});

adminBroadcastArchiveMenu.dynamic(async (ctx, range) => {
    await broadcastService.pruneCompletedArchive(ARCHIVE_KEEP_COMPLETED);

    const broadcasts = await broadcastService.getRecentBroadcasts(ARCHIVE_KEEP_COMPLETED + 20);
    const completedBroadcasts = broadcasts.filter((broadcast: any) => !isBroadcastActive(broadcast));
    const totalPages = Math.max(1, Math.ceil(completedBroadcasts.length / ARCHIVE_PAGE_SIZE));
    const requestedPage = Number((ctx.session as any).broadcastArchivePage || 0);
    const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
    (ctx.session as any).broadcastArchivePage = page;
    const pageItems = completedBroadcasts.slice(page * ARCHIVE_PAGE_SIZE, (page + 1) * ARCHIVE_PAGE_SIZE);

    if (pageItems.length === 0) {
        range.text("✅ Archive is empty", async (ctx) => {
            await ctx.answerCallbackQuery().catch(() => { });
        }).row();
    } else {
        pageItems.forEach((broadcast: any) => {
            const date = new Date(broadcast.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
            const label = `✅ ${date} #${broadcast.id} | ${broadcast.targetSummary || 'Broadcast'}`;

            range.text(label, async (ctx) => {
                if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
                ctx.session.candidateData.city = broadcast.id.toString();

                const stats = await broadcastService.getStats(broadcast.id);
                const statsText = `📊 <b>Broadcast Statistics (ID: ${broadcast.id})</b>\n\n` +
                    `🌐 Total chats: <b>${stats.totalChats}</b>\n` +
                    `✅ Confirmed: <b>${stats.confirmed}</b>\n` +
                    `❌ Declined: <b>${stats.declined}</b>\n` +
                    `⏳ Pending: <b>${stats.pending}</b>`;
                await ScreenManager.renderScreen(ctx, statsText, "admin-broadcast-manage", { pushToStack: true });
            }).row();
        });
    }

    if (totalPages > 1) {
        if (page > 0) {
            range.text("⬅️ Prev", async (ctx) => {
                (ctx.session as any).broadcastArchivePage = page - 1;
                await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive");
            });
        }
        if (page < totalPages - 1) {
            range.text("Next ➡️", async (ctx) => {
                (ctx.session as any).broadcastArchivePage = page + 1;
                await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive");
            });
        }
        range.row();
    }

    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list");
    });
});

adminBroadcastHandlers.callbackQuery("br_stop_all_pings_exec", async (ctx) => {
    const stopped = await broadcastService.stopAllPings();
    await ctx.answerCallbackQuery("Done").catch(() => { });
    await ScreenManager.renderScreen(ctx, `⏹️ <b>Active pings stopped:</b> ${stopped}`, "admin-broadcast-list");
});

adminBroadcastHandlers.callbackQuery("br_stop_all_pings_cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled").catch(() => { });
    await ScreenManager.goBack(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list");
});

adminBroadcastManageMenu.dynamic(async (ctx, range) => {
    const bId = Number(ctx.session.candidateData?.city);
    if (!bId) return;

    range.text("🔄 Refresh Stats", async (ctx) => {
        const freshStats = await broadcastService.getStats(bId);
        const freshText = `📊 <b>Broadcast Statistics (ID: ${bId})</b>\n\n` +
            `🌐 Total chats: <b>${freshStats.totalChats}</b>\n` +
            `✅ Confirmed: <b>${freshStats.confirmed}</b>\n` +
            `❌ Declined: <b>${freshStats.declined}</b>\n` +
            `⏳ Pending: <b>${freshStats.pending}</b>\n\n` +
            `<i>Last updated: ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</i>`;

        await ScreenManager.renderScreen(ctx, freshText, "admin-broadcast-manage");
    }).row()
        .text("⏹ Stop Pings", async (ctx) => {
            await broadcastService.stopPinging(bId);
            await ctx.answerCallbackQuery("Pings stopped").catch(() => { });

            const freshStats = await broadcastService.getStats(bId);
            const freshText = `📊 <b>Broadcast Statistics (ID: ${bId})</b>\n\n` +
                `🌐 Total chats: <b>${freshStats.totalChats}</b>\n` +
                `✅ Confirmed: <b>${freshStats.confirmed}</b>\n` +
                `❌ Declined: <b>${freshStats.declined}</b>\n` +
                `⏳ Pending: <b>${freshStats.pending}</b>\n\n` +
                `⏹️ <b>Auto-pings are stopped for this broadcast.</b>`;
            await ScreenManager.renderScreen(ctx, freshText, "admin-broadcast-manage");
        }).row()
        .text("🗑️ Delete", async (ctx) => {
            await broadcastService.deleteBroadcast(ctx, bId);
            await ctx.answerCallbackQuery("✅ Deleted.").catch(() => { });
            await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
        }).row()
        .text("⬅️ Back", async (ctx) => {
            await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
        });
});

adminBroadcastHandlers.callbackQuery("b_test", async (ctx: MyContext) => {
    const draft = ctx.session.broadcastDraft;
    if (!draft) return ctx.answerCallbackQuery("Session expired.").catch(() => { });
    await ctx.answerCallbackQuery("🧪 Sending test...").catch(() => { });

    try {
        await broadcastService.sendTestBroadcast(
            ctx.api,
            ctx.from!.id,
            draft.textHtml,
            draft.media,
            draft.buttonType || 'default'
        );

        ctx.session.broadcastTestConfirmed = true;
        audit({ event: "broadcast_test", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id, context: { targetType: draft.targetType } });

        // Update review screen to show test sent
        const stats = draft.targetStats;
        const mediaSummary = getMediaSummary(Array.isArray(draft.media) ? draft.media : (draft.media ? [draft.media] : []));
        const preview = getBroadcastPreview(draft.textHtml, draft.targetType, stats, true, true, draft.buttonType || 'default', mediaSummary);
        const kb = getBroadcastKb(true, true, stats);
        kb.row().text("🔄 Start Over", "br_restart").text("✖️ Cancel", "br_cancel").danger();

        await ctx.editMessageText(preview, { reply_markup: kb }).catch(() => { });
    } catch (e: any) {
        logger.error({ err: e }, "Broadcast test failed");
        await ctx.reply(`❌ Test failed: ${e.message}`);
    }
});

adminBroadcastHandlers.callbackQuery("b_send", async (ctx: MyContext) => {
    const draft = ctx.session.broadcastDraft;
    if (!draft) return;
    await ctx.answerCallbackQuery("⏳ Sending...").catch(() => { });

    try {
        const pingOptions = draft.buttonType ? { buttonType: draft.buttonType } : undefined;
        const count = await broadcastService.createBroadcast(
            ctx.api,
            ctx.from!.id,
            draft.textHtml,
            { type: draft.targetType as any, value: (ctx.session as any).broadcastValue },
            draft.media,
            ctx.me.username,
            pingOptions
        );

        audit({ event: "broadcast_send", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id, context: { targetType: draft.targetType, count } });

        const mediaSummary = getMediaSuccessSummary(Array.isArray(draft.media) ? draft.media : (draft.media ? [draft.media] : []));
        const successText = `✅ Broadcast queued for ${count} target${count === 1 ? '' : 's'}!${mediaSummary ? `\n\n${mediaSummary}` : ''}`;
        const kb = new InlineKeyboard().text("🏠 Main Menu", "admin_main_menu");

        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        if (ctx.session.adminFlow === "BROADCAST") {
            delete ctx.session.adminFlow;
        }
        await ScreenManager.renderScreen(ctx, successText, kb, { forceNew: true });
    } catch (e: any) {
        audit({ event: "broadcast_send", result: "failed", actorType: "admin", telegramId: ctx.from?.id, entityType: "broadcast", updateId: ctx.update.update_id, error: e.message });
        logger.error({ err: e }, "Broadcast send failed");
        await ctx.reply(`❌ Error: ${e.message}`);
    }
});
