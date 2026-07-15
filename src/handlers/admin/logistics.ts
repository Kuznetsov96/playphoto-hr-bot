import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import prisma from "../../db/core.js";
import { LOGISTICS_TEXTS_ADMIN } from "../../constants/logistics-constants.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { Menu } from "@grammyjs/menu";
import { menuRegistry } from "../../utils/menu-registry.js";
import { TEAM_CHATS } from "../../config.js";
import { audit } from "../../core/audit-logger.js";
import { formatLogisticsLocation, formatLogisticsPhotographerName } from "../../utils/logistics-formatters.js";

export const adminLogisticsHandlers = new Composer<MyContext>();

function buildParcelSetLocationCallback(parcelId: string, locationId: string): string {
    return `apsl_${parcelId}_${locationId}`;
}

// --- Logistics Admin Menu ---
export const adminLogisticsMenu = new Menu<MyContext>("admin-logistics");
menuRegistry.register(adminLogisticsMenu);

adminLogisticsMenu.dynamic(async (ctx, range) => {
    const activeParcels = await prisma.parcel.findMany({
        where: {
            status: { notIn: ['COMPLETED', 'CANCELLED'] }
        },
        include: { location: true, responsibleStaff: true },
        orderBy: { updatedAt: 'desc' },
        take: 8
    });

    if (activeParcels.length === 0) {
        range.text("No active parcels ✨", (ctx) => ctx.answerCallbackQuery("Everything is up to date!"));
    } else {
        activeParcels.forEach(p => {
            const statusIcon = p.status === 'VERIFYING' ? '📸' : (p.status === 'ARRIVED' ? '🔔' : '⏳');
            const label = `${statusIcon} ${p.ttn} (${p.location?.name || 'Unassigned'})`;
            range.text(label, async (ctx) => {
                await showParcelDetails(ctx, p.id);
            }).row();
        });
    }

    range.row().text("➕ Add TTN", async (ctx) => {
        ctx.session.adminFlow = "LOGISTICS";
        ctx.session.step = "admin_logistics_add_ttn";
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.manualChannelAccess;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;
        await ctx.reply("Please enter the 14-digit TTN number: 📦");
        await ctx.answerCallbackQuery();
    });

    range.row().text("⬅️ Back", async (ctx) => {
        if (ctx.session.adminFlow === "LOGISTICS") {
            delete ctx.session.adminFlow;
        }
        if (ctx.session.step === "admin_logistics_add_ttn") {
            ctx.session.step = "idle";
        }
        await ScreenManager.goBack(ctx, "🛠 System Management", "admin-system");
    });
});

async function showParcelDetails(ctx: MyContext, parcelId: string) {
    const parcel = await prisma.parcel.findUnique({
        where: { id: parcelId },
        include: { location: true, responsibleStaff: true }
    });

    if (!parcel) return;

    const text = `📦 <b>Parcel Details</b>\n\n` +
        `<b>TTN:</b> <code>${parcel.ttn}</code>\n` +
        `<b>Status:</b> ${parcel.status}\n` +
        `<b>Location:</b> ${parcel.location?.name || '⚠️ Not assigned'}\n` +
        `<b>NP City:</b> ${(parcel as any).npCity || 'N/A'}\n` +
        `<b>NP Address:</b> ${(parcel as any).npAddress || 'N/A'}\n` +
        `<b>Type:</b> ${parcel.deliveryType}\n` +
        `<b>Staff:</b> ${parcel.responsibleStaff?.fullName || 'None'}\n` +
        `<b>Rejections:</b> ${parcel.rejectionCount}\n\n` +
        `<i>Description: ${parcel.description || 'N/A'}</i>`;

    const kb = new InlineKeyboard();

    if (parcel.contentPhotoIds.length > 0) {
        kb.text(`🖼 View Photo${parcel.contentPhotoIds.length > 1 ? 's' : ''} (${parcel.contentPhotoIds.length})`, `admin_parcel_view_${parcel.id}`).row();
    }

    if (parcel.status !== 'COMPLETED' && parcel.status !== 'CANCELLED') {
        if (parcel.contentPhotoIds.length === 0) {
            kb.text(LOGISTICS_TEXTS_ADMIN.btn_mark_picked_up_manual, `admin_parcel_manual_pickup_${parcel.id}`).row();
        }
        kb.text("✅ Complete", `admin_parcel_confirm_${parcel.id}`).row();
    }

    kb.text("🗑 Delete", `admin_parcel_delete_${parcel.id}`).danger().row();
    kb.text("📍 Set Location", `admin_parcel_loc_${parcel.id}`).row();
    kb.text("⬅️ Back to List", "admin_logistics_nav");

    if (TEAM_CHATS.LOGISTICS) {
        kb.url("💬 Open Chat", `https://t.me/c/${Math.abs(TEAM_CHATS.SUPPORT).toString().substring(3)}/${TEAM_CHATS.LOGISTICS}`);
    }

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
}

// --- Callback Handlers ---

// Navigation to logistics list
adminLogisticsHandlers.callbackQuery("admin_logistics_nav", async (ctx) => {
    await ScreenManager.renderScreen(ctx, "📦 <b>Logistics Management</b>", "admin-logistics");
    await ctx.answerCallbackQuery();
});

// Confirm Parcel - supports legacy admin_parcel_confirm_* and short apc_* callbacks.
adminLogisticsHandlers.callbackQuery(/^(?:admin_parcel_confirm_(?:direct_)?|apc_)(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const isDirect = ctx.callbackQuery.data.includes('_direct_') || ctx.callbackQuery.data.startsWith('apc_');

    const parcel = await prisma.parcel.update({
        where: { id: parcelId },
        data: { status: 'COMPLETED' }
    });

    audit({ event: "parcel_confirm", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

    await ctx.answerCallbackQuery("Parcel confirmed! ✅");

    if (isDirect || ctx.chat?.id === TEAM_CHATS.SUPPORT) {
        // Safety: if triggered from support chat (even via old menu), stay silent
        const text = `✅ <b>Parcel confirmed and archived.</b>\n\n<b>TTN:</b> <code>${parcel.ttn}</code>`;
        if (ctx.callbackQuery.message?.photo) {
            await ctx.editMessageCaption({ caption: text, parse_mode: 'HTML' });
        } else {
            await ctx.editMessageText(text, { parse_mode: 'HTML' });
        }
    } else {
        await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.confirmed, "admin-logistics");
    }
});

adminLogisticsHandlers.callbackQuery(/^admin_parcel_manual_pickup_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const { logisticsService } = await import("../../services/logistics-service.js");

    const updated = await logisticsService.markPickedUpManually(parcelId, {
        telegramId: ctx.from?.id,
        source: 'admin_logistics',
        notifyStaff: true,
    });

    if (!updated) {
        await ctx.answerCallbackQuery("Parcel not found.");
        return;
    }

    audit({ event: "parcel_manual_pickup", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

    await ctx.answerCallbackQuery("Manual pickup marked.");
    await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.manual_pickup_marked, "admin-logistics");
});

adminLogisticsHandlers.callbackQuery(/^admin_parcel_manual_proxy_done_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const { logisticsService } = await import("../../services/logistics-service.js");
    const updated = await logisticsService.notifyManualProxyReady(parcelId);

    if (!updated) {
        await ctx.answerCallbackQuery("Parcel not found.");
        return;
    }

    await prisma.parcel.update({
        where: { id: parcelId },
        data: {
            npTrusteeError: null,
            npTrusteeLastAttemptAt: new Date()
        }
    });

    audit({ event: "parcel_manual_proxy_done", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

    await ctx.answerCallbackQuery("Manual proxy confirmed.");

    if (ctx.chat?.id === TEAM_CHATS.SUPPORT) {
        const text = `✅ <b>Manual proxy confirmed.</b>\n\nPhotographer can continue with the content photo flow.`;
        if (ctx.callbackQuery.message?.photo) {
            await ctx.editMessageCaption({ caption: text, parse_mode: 'HTML' });
        } else {
            await ctx.editMessageText(text, { parse_mode: 'HTML' });
        }
        return;
    }

    await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.manual_proxy_marked, "admin-logistics");
});

// Delete Parcel - supports legacy admin_parcel_delete_* and short apd_* callbacks.
adminLogisticsHandlers.callbackQuery(/^(?:admin_parcel_delete_(?:direct_)?|apd_)(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const isDirect = ctx.callbackQuery.data.includes('_direct_') || ctx.callbackQuery.data.startsWith('apd_');

    await prisma.parcel.update({ where: { id: parcelId }, data: { status: 'CANCELLED' } }).catch(() => { });

    audit({ event: "parcel_delete", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

    await ctx.answerCallbackQuery("Parcel deleted. 🗑");

    if (isDirect || ctx.chat?.id === TEAM_CHATS.SUPPORT) {
        const text = `🗑 <b>Parcel deleted.</b>`;
        if (ctx.callbackQuery.message?.photo) {
            await ctx.editMessageCaption({ caption: text, parse_mode: 'HTML' });
        } else {
            await ctx.editMessageText(text, { parse_mode: 'HTML' });
        }
    } else {
        await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.menu_title, "admin-logistics");
    }
});

// Select Location Menu
adminLogisticsHandlers.callbackQuery(/^admin_parcel_loc_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const locations = await prisma.location.findMany({ where: { isHidden: false }, orderBy: { name: 'asc' } });

    const kb = new InlineKeyboard();
    locations.forEach(loc => {
        kb.text(loc.name, buildParcelSetLocationCallback(parcelId, loc.id)).row();
    });
    kb.text("⬅️ Cancel", `admin_parcel_view_details_${parcelId}`);

    await ctx.editMessageText("📍 <b>Select Location for this parcel:</b>", { parse_mode: 'HTML', reply_markup: kb });
    await ctx.answerCallbackQuery();
});

// Set Location Action — also learns npAddressRef for future auto-mapping
adminLogisticsHandlers.callbackQuery(/^apsl_([^_]+)_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const locId = ctx.match[2] as string;

    await ctx.answerCallbackQuery("Location updated! 📍");

    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });

    await prisma.parcel.update({
        where: { id: parcelId },
        data: { locationId: locId }
    });

    audit({ event: "parcel_set_location", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, context: { locationId: locId } });

    // Auto-learn: save NP address ref to location for future auto-mapping
    if (parcel?.npAddressRef) {
        const location = await prisma.location.findUnique({ where: { id: locId } });
        if (location && !location.npAddressRef) {
            await prisma.location.update({
                where: { id: locId },
                data: { npAddressRef: parcel.npAddressRef }
            });
        }
    }

    // Notify staff on shift about this parcel now that location is assigned
    const { logisticsService } = await import("../../services/logistics-service.js");
    await logisticsService.notifyStaffOnShift(parcelId, parcel?.status || 'EXPECTED');

    await showParcelDetails(ctx, parcelId);
});

// Back to details from location selection
adminLogisticsHandlers.callbackQuery(/^admin_parcel_view_details_(.+)$/, async (ctx) => {
    await showParcelDetails(ctx, ctx.match[1] as string);
    await ctx.answerCallbackQuery();
});

// View Parcel Photo
adminLogisticsHandlers.callbackQuery(/^admin_parcel_view_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const parcel = await prisma.parcel.findUnique({
        where: { id: parcelId },
        include: {
            location: true,
            responsibleStaff: {
                include: {
                    user: {
                        select: {
                            firstName: true,
                            lastName: true,
                            username: true
                        }
                    }
                }
            }
        }
    });

    if (parcel && parcel.contentPhotoIds.length > 0) {
        const kb = new InlineKeyboard()
            .text("✅ Everything is fine", `apc_${parcel.id}`)
            .text("🗑 Delete", `apd_${parcel.id}`).danger();

        // Only show navigation in private bot chat
        if (ctx.chat?.type === 'private') {
            kb.row().text("⬅️ Back to list", "admin_logistics_nav");
        }

        const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
            ttn: parcel.ttn,
            location: formatLogisticsLocation(parcel.location),
            sender: formatLogisticsPhotographerName(parcel.responsibleStaff)
        });

        const chatId = ctx.chat!.id;
        const threadOptions: any = {};
        if (TEAM_CHATS.LOGISTICS && ctx.chat?.type !== 'private') {
            threadOptions.message_thread_id = TEAM_CHATS.LOGISTICS;
        }

        if (parcel.contentPhotoIds.length === 1) {
            await ctx.api.sendPhoto(chatId, parcel.contentPhotoIds[0]!, {
                caption, parse_mode: 'HTML', reply_markup: kb, ...threadOptions
            });
        } else {
            // Send as media group (album), then a separate message with buttons
            const media = parcel.contentPhotoIds.map((id, i) => ({
                type: 'photo' as const,
                media: id,
                ...(i === 0 ? { caption, parse_mode: 'HTML' as const } : {})
            }));
            await ctx.api.sendMediaGroup(chatId, media, threadOptions);
            await ctx.api.sendMessage(chatId, `⬆️ ${parcel.contentPhotoIds.length} photos for TTN <code>${parcel.ttn}</code>`, {
                parse_mode: 'HTML', reply_markup: kb, ...threadOptions
            });
        }
        await ctx.answerCallbackQuery();
    } else {
        await ctx.answerCallbackQuery("No photo available.");
    }
});

// --- Message Handler for manual TTN ---
adminLogisticsHandlers.on("message:text", async (ctx, next) => {
    if (ctx.session.adminFlow !== "LOGISTICS" || ctx.session.step !== "admin_logistics_add_ttn") return next();

    const ttn = ctx.message.text.trim();
    if (ttn.length !== 14 || !/^\d+$/.test(ttn)) {
        return ctx.reply("❌ Invalid TTN format. Please enter 14 digits.");
    }

    try {
        const { logisticsService } = await import("../../services/logistics-service.js");
        // We simulate a document from NP to trigger mapping
        const doc = {
            Number: ttn,
            StatusCode: '1', // Expected
            CargoDescription: 'Manual Entry'
        };

        // Use internal method through any to bypass private if needed, 
        // but better add a public entry point.
        // For now, let's just create it directly.
        await prisma.parcel.upsert({
            where: { ttn },
            update: { status: 'EXPECTED' },
            create: {
                ttn,
                status: 'EXPECTED',
                deliveryType: 'Warehouse',
                description: 'Manual entry'
            }
        });

        ctx.session.step = "idle";
        if (ctx.session.adminFlow === "LOGISTICS") {
            delete ctx.session.adminFlow;
        }

        audit({ event: "parcel_add_ttn", result: "success", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", updateId: ctx.update.update_id, context: { ttn } });

        await ctx.reply(`✅ TTN <code>${ttn}</code> added! Tracking will begin on next sync.`, { parse_mode: 'HTML' });
        await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.menu_title, "admin-logistics");
    } catch (error: any) {
        audit({ event: "parcel_add_ttn", result: "failed", actorType: "admin", telegramId: ctx.from?.id, entityType: "parcel", updateId: ctx.update.update_id, error: error.message, context: { ttn } });
        await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
});
