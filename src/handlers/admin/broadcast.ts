import { Composer, InlineKeyboard } from "grammy";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { broadcastService } from "../../services/broadcast.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { normalizeCity, msgToHtml } from "./utils.js";
import { getBroadcastKb, getBroadcastPreview, formatTargetLabel } from "./broadcast-helpers.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";

export const adminBroadcastHandlers = new Composer<MyContext>();

// --- MENUS (Declared first to avoid cycles) ---
export const adminBroadcastHubMenu = new Menu<MyContext>("admin-broadcast-hub");
export const adminBroadcastListMenu = new Menu<MyContext>("admin-broadcast-list");
export const adminBroadcastArchiveMenu = new Menu<MyContext>("admin-broadcast-archive");
export const adminBroadcastManageMenu = new Menu<MyContext>("admin-broadcast-manage");

/**
 * Entry point from the menu
 */
export async function startStatelessBroadcast(ctx: MyContext) {
    ctx.session.adminFlow = 'BROADCAST';
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
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
        .text("❌ Cancel", "br_cancel");

    const text = "📢 <b>BROADCAST:</b> Select recipients:";
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

/**
 * Handle Target Type Selection
 */
adminBroadcastHandlers.callbackQuery(/^br_type_(.+)$/, async (ctx) => {
    const type = ctx.match![1] as any;
    if (!ctx.session.broadcastData) return ctx.answerCallbackQuery("Session expired.");

    ctx.session.broadcastData.targetType = type;

    if (type === 'city_chats' || type === 'pm_city') {
        ctx.session.broadcastData.step = 'SELECT_TARGET';
        await renderCitySelection(ctx);
    } else {
        ctx.session.broadcastData.step = 'SELECT_BUTTONS';
        await renderButtonSelection(ctx);
    }
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_confirm_cities", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    
    const type = ctx.session.broadcastData.targetType;
    if (type === 'pm_city' || type === 'city_chats') {
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
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_scope_all", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    ctx.session.broadcastData.step = 'SELECT_BUTTONS';
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_scope_locs", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    const currentType = ctx.session.broadcastData.targetType;
    ctx.session.broadcastData.targetType = currentType === 'pm_city' ? 'pm_location' : 'city_chat_location';
    await renderLocationSelection(ctx);
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_confirm_locs", async (ctx) => {
    if (!ctx.session.broadcastData) return;
    ctx.session.broadcastData.targetValue = ctx.session.broadcastData.selectedLocs || [];
    ctx.session.broadcastData.step = 'SELECT_BUTTONS';
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery();
});

async function renderContentPrompt(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const targetLabel = formatTargetLabel(data.targetType!);
    const text = `📢 <b>Broadcast Content</b>\nTarget: <b>${targetLabel}</b>\nButtons: <code>${data.buttonType || 'default'}</code>\n\n` +
        `👇 <b>Please send the message now.</b>\n` +
        `It can be text, photo or video with a caption.\n\n` +
        `<i>Formatting (bold, links, etc.) will be preserved.</i>`;

    const kb = new InlineKeyboard().text("⬅️ Back", "br_confirm_buttons").text("❌ Cancel", "br_cancel");
    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

adminBroadcastHandlers.callbackQuery("br_confirm_buttons", async (ctx) => {
    await renderButtonSelection(ctx);
    await ctx.answerCallbackQuery();
});

export async function handleBroadcastContent(ctx: MyContext) {
    if (!ctx.session.broadcastData || ctx.session.broadcastData.step !== 'AWAITING_CONTENT') return false;
    if (ctx.session.adminFlow !== 'BROADCAST') return false;
    if (ctx.chat?.type !== "private") return false;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasAnyRole } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    if (!hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT')) return false;

    const message = ctx.message;
    if (!message) return false;

    let media: { type: 'photo' | 'video', fileId: string } | undefined;
    if (message.photo) media = { type: 'photo', fileId: message.photo[message.photo.length - 1]!.file_id };
    else if (message.video) media = { type: 'video', fileId: message.video.file_id };

    const textHtml = msgToHtml(message.text || message.caption || "", message.entities || message.caption_entities || []);
    
    if (!textHtml && !media) {
        await ctx.reply("❌ Please send some content (text or media).");
        return true;
    }

    ctx.session.broadcastData.text = textHtml;
    if (media) ctx.session.broadcastData.media = media;
    ctx.session.broadcastData.step = 'CONFIRMATION';

    try { await ctx.deleteMessage(); } catch {}

    await renderReview(ctx);
    return true;
}

async function renderReview(ctx: MyContext) {
    const data = ctx.session.broadcastData;
    if (!data) return;

    const stats = await broadcastService.getBroadcastTargetStats({ 
        type: data.targetType as any, 
        value: data.targetValue || [] 
    });
    const preview = getBroadcastPreview(data.text || "", data.targetType as any, stats, false, false, data.buttonType || 'default');
    const kb = getBroadcastKb(false, false, stats);

    kb.row().text("🔄 Start Over", "br_restart").text("❌ Cancel", "br_cancel");

    ctx.session.broadcastDraft = {
        textHtml: data.text || "",
        targetType: data.targetType as any,
        targetStats: stats,
        confirmChatId: ctx.chat!.id,
        buttonType: data.buttonType as any
    };
    if (data.media) ctx.session.broadcastDraft.media = data.media;
    (ctx.session as any).broadcastValue = data.targetValue;

    if (data.media?.type === 'photo') {
        const msg = await ctx.replyWithPhoto(data.media.fileId, { caption: preview, parse_mode: "HTML", reply_markup: kb });
        data.menuMessageId = msg.message_id;
    } else if (data.media?.type === 'video') {
        const msg = await ctx.replyWithVideo(data.media.fileId, { caption: preview, parse_mode: "HTML", reply_markup: kb });
        data.menuMessageId = msg.message_id;
    } else {
        const msg = await ctx.reply(preview, { parse_mode: "HTML", reply_markup: kb });
        data.menuMessageId = msg.message_id;
    }
}

adminBroadcastHandlers.callbackQuery("br_cancel", async (ctx) => {
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    await ctx.answerCallbackQuery("❌ Cancelled.");
    await ScreenManager.renderScreen(ctx, "❌ Broadcast creation cancelled.", new InlineKeyboard().text("🏠 Back to Hub", "br_to_hub"));
});

adminBroadcastHandlers.callbackQuery("br_restart", async (ctx) => {
    await startStatelessBroadcast(ctx);
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_to_hub", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery();
});

adminBroadcastHandlers.callbackQuery("br_back_to_main", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery();
});

// --- MENU IMPLEMENTATIONS ---

adminBroadcastListMenu.dynamic(async (ctx, range) => {
    const broadcasts = await broadcastService.getRecentBroadcasts(5);
    if (broadcasts.length === 0) range.text("✅ No active broadcasts", (ctx) => ctx.answerCallbackQuery()).row();
    else {
        broadcasts.forEach((b: any) => {
            const date = new Date(b.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
            range.text(`${date} | ${b.targetSummary || 'Broadcast'}`, async (ctx) => {
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
    range.text("🗄️ Archive", async (ctx) => {
        await ScreenManager.renderScreen(ctx, "🗄️ <b>Archive</b>", "admin-broadcast-archive", { pushToStack: true });
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

    range.text("📜 History / Manage", async (ctx) => {
        await ScreenManager.renderScreen(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list", { pushToStack: true });
    }).row();
    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "🛠️ <b>System Settings</b>", "admin-system");
    });
});

adminBroadcastArchiveMenu.dynamic(async (ctx, range) => {
    const broadcasts = await broadcastService.getRecentBroadcasts(20);
    broadcasts.forEach((b: any) => {
        const date = new Date(b.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
        range.text(`✅ ${date} | ${b.messageText?.substring(0, 15) || '[Media]'}`, async (ctx) => {
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
    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
    });
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
        .text("🗑️ Delete", async (ctx) => {
            await broadcastService.deleteBroadcast(ctx, bId);
            await ctx.answerCallbackQuery("✅ Deleted.");
            await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
        }).row()
        .text("⬅️ Back", async (ctx) => {
            await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
        });
        });

adminBroadcastHandlers.callbackQuery("b_test", async (ctx: MyContext) => {
    const draft = ctx.session.broadcastDraft;
    if (!draft) return ctx.answerCallbackQuery("Session expired.");
    await ctx.answerCallbackQuery("🧪 Sending test...");

    try {
        await broadcastService.sendTestBroadcast(
            ctx.api,
            ctx.from!.id,
            draft.textHtml,
            draft.media,
            draft.buttonType || 'default'
        );

        ctx.session.broadcastTestConfirmed = true;
        
        // Update review screen to show test sent
        const stats = draft.targetStats;
        const preview = getBroadcastPreview(draft.textHtml, draft.targetType, stats, true, true, draft.buttonType || 'default');
        const kb = getBroadcastKb(true, true, stats);
        kb.row().text("🔄 Start Over", "br_restart").text("❌ Cancel", "br_cancel");

        if (draft.media) {
            await ctx.editMessageCaption({ caption: preview, reply_markup: kb }).catch(() => { });
        } else {
            await ctx.editMessageText(preview, { reply_markup: kb }).catch(() => { });
        }
    } catch (e: any) {
        logger.error({ err: e }, "Broadcast test failed");
        await ctx.reply(`❌ Test failed: ${e.message}`);
    }
});

adminBroadcastHandlers.callbackQuery("b_send", async (ctx: MyContext) => {
    const draft = ctx.session.broadcastDraft;
    if (!draft) return;
    await ctx.answerCallbackQuery("⏳ Sending...");

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

        const successText = `✅ Broadcast sent to ${count} targets!`;
        const kb = new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities");

        if (draft.media) {
            await ctx.editMessageCaption({ caption: successText, reply_markup: kb }).catch(() => { });
        } else {
            await ctx.editMessageText(successText, { reply_markup: kb }).catch(() => { });
        }

        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
    } catch (e: any) {
        logger.error({ err: e }, "Broadcast send failed");
        await ctx.reply(`❌ Error: ${e.message}`);
    }
});
