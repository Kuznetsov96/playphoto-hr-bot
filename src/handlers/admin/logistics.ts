import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import prisma from "../../db/core.js";
import { LOGISTICS_TEXTS_ADMIN } from "../../constants/logistics-constants.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { Menu } from "@grammyjs/menu";
import { menuRegistry } from "../../utils/menu-registry.js";
import { TEAM_CHATS } from "../../config.js";

export const adminLogisticsHandlers = new Composer<MyContext>();

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
        ctx.session.step = "admin_logistics_add_ttn";
        await ctx.reply("Please enter the 14-digit TTN number: 📦");
        await ctx.answerCallbackQuery();
    });

    range.row().text("⬅️ Back", async (ctx) => {
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
        kb.text("✅ Complete", `admin_parcel_confirm_${parcel.id}`).row();
    }

    kb.text("🗑 Delete", `admin_parcel_delete_${parcel.id}`).row();
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

// Confirm Parcel (Everything is fine) - matches both admin_parcel_confirm_TTN AND admin_parcel_confirm_direct_TTN
adminLogisticsHandlers.callbackQuery(/^admin_parcel_confirm_(?:direct_)?(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const isDirect = ctx.callbackQuery.data.includes('_direct_');

    await prisma.parcel.update({
        where: { id: parcelId },
        data: { status: 'COMPLETED' }
    });

    await ctx.answerCallbackQuery("Parcel confirmed! ✅");

    if (isDirect || ctx.chat?.id === TEAM_CHATS.SUPPORT) {
        // Safety: if triggered from support chat (even via old menu), stay silent
        const text = `✅ <b>Parcel confirmed and archived.</b>`;
        if (ctx.callbackQuery.message?.photo) {
            await ctx.editMessageCaption({ caption: text, parse_mode: 'HTML' });
        } else {
            await ctx.editMessageText(text, { parse_mode: 'HTML' });
        }
    } else {
        await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.confirmed, "admin-logistics");
    }
});

// Delete Parcel - matches both admin_parcel_delete_TTN AND admin_parcel_delete_direct_TTN
adminLogisticsHandlers.callbackQuery(/^admin_parcel_delete_(?:direct_)?(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const isDirect = ctx.callbackQuery.data.includes('_direct_');
    
    await prisma.parcel.update({ where: { id: parcelId }, data: { status: 'CANCELLED' } }).catch(() => { });
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
        kb.text(loc.name, `admin_parcel_set_loc_${parcelId}_${loc.id}`).row();
    });
    kb.text("⬅️ Cancel", `admin_parcel_view_details_${parcelId}`);

    await ctx.editMessageText("📍 <b>Select Location for this parcel:</b>", { parse_mode: 'HTML', reply_markup: kb });
    await ctx.answerCallbackQuery();
});

// Set Location Action — also learns npAddressRef for future auto-mapping
adminLogisticsHandlers.callbackQuery(/^admin_parcel_set_loc_(.+)_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const locId = ctx.match[2] as string;

    await ctx.answerCallbackQuery("Location updated! 📍");

    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });

    await prisma.parcel.update({
        where: { id: parcelId },
        data: { locationId: locId }
    });

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
    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId }, include: { location: true, responsibleStaff: true } });

    if (parcel && parcel.contentPhotoIds.length > 0) {
        const kb = new InlineKeyboard()
            .text("✅ Everything is fine", `admin_parcel_confirm_direct_${parcel.id}`)
            .text("🗑 Delete", `admin_parcel_delete_direct_${parcel.id}`);

        // Only show navigation in private bot chat
        if (ctx.chat?.type === 'private') {
            kb.row().text("⬅️ Back to list", "admin_logistics_nav");
        }

        const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
            ttn: parcel.ttn,
            location: parcel.location?.name || 'Unknown',
            sender: parcel.responsibleStaff?.fullName || 'Photographer'
        });

        const chatId = ctx.chat!.id;
        const threadOptions: any = {};
        if (TEAM_CHATS.LOGISTICS) {
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
    if (ctx.session.step !== "admin_logistics_add_ttn") return next();

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
        await ctx.reply(`✅ TTN <code>${ttn}</code> added! Tracking will begin on next sync.`, { parse_mode: 'HTML' });
        await ScreenManager.renderScreen(ctx, LOGISTICS_TEXTS_ADMIN.menu_title, "admin-logistics");
    } catch (error) {
        await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
});
