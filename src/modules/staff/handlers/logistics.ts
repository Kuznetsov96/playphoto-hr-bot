import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import prisma from "../../../db/core.js";
import { LOGISTICS_TEXTS_STAFF, LOGISTICS_TEXTS_ADMIN } from "../../../constants/logistics-constants.js";
import { TEAM_CHATS } from "../../../config.js";

export const staffLogisticsHandlers = new Composer<MyContext>();

// 1. Accept Parcel
staffLogisticsHandlers.callbackQuery(/^parcel_accept_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        include: { staffProfile: true }
    });

    if (!user || !user.staffProfile) return;

    const parcel = await prisma.parcel.findUnique({
        where: { id: parcelId },
        include: { responsibleStaff: true }
    });

    if (!parcel) return ctx.answerCallbackQuery("Parcel not found.");
    
    if (parcel.responsibleStaffId && parcel.responsibleStaffId !== user.staffProfile.id) {
        return ctx.editMessageText(LOGISTICS_TEXTS_STAFF.already_taken(parcel.responsibleStaff?.fullName || 'another photographer'), { parse_mode: 'HTML' });
    }

    // Assign responsible staff
    await prisma.parcel.update({
        where: { id: parcelId },
        data: { 
            responsibleStaffId: user.staffProfile.id,
            status: 'PICKUP_IN_PROGRESS'
        }
    });

    // Ask for phone confirmation
    const phoneToUse = user.staffProfile.npPhone || user.staffProfile.phone || '';
    const kb = new InlineKeyboard()
        .text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`)
        .text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

    await ctx.editMessageText(LOGISTICS_TEXTS_STAFF.ask_phone(phoneToUse), {
        parse_mode: 'HTML',
        reply_markup: kb
    });
    await ctx.answerCallbackQuery();
});

// 2. Reject Parcel
staffLogisticsHandlers.callbackQuery(/^parcel_reject_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
    if (!parcel) return;

    const newRejectionCount = parcel.rejectionCount + 1;
    await prisma.parcel.update({
        where: { id: parcelId },
        data: { 
            rejectionCount: newRejectionCount,
            lastRejectionAt: new Date()
        }
    });

    const { logisticsService } = await import("../../../services/logistics-service.js");
    await logisticsService.notifySupport(parcelId, 'REJECTED');

    await ctx.editMessageText("Окей, я передам цю задачу наступній зміні. Дякую!", { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
});

// 3. Confirm Phone
staffLogisticsHandlers.callbackQuery(/^parcel_phone_ok_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcelId}`);
    
    await ctx.editMessageText("Чудово! Доручення оформлено. Натисни кнопку нижче, коли забереш посилку та сфотографуєш її вміст. ✨", {
        parse_mode: 'HTML',
        reply_markup: kb
    });
    await ctx.answerCallbackQuery();
});

// 4. Change Phone
staffLogisticsHandlers.callbackQuery(/^parcel_phone_change_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    ctx.session.step = `awaiting_np_phone_${parcelId}`;
    await ctx.editMessageText("Будь ласка, введи номер телефону для оформлення доручення (у форматі 380...):", { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
});

// 5. Trigger Photo Upload
staffLogisticsHandlers.callbackQuery(/^parcel_photo_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    ctx.session.step = `awaiting_parcel_photo_${parcelId}`;
    await ctx.reply("Будь ласка, надішліть фото вмісту посилки: 📸");
    await ctx.answerCallbackQuery();
});

// Handle text and photo inputs
staffLogisticsHandlers.on("message", async (ctx, next) => {
    const step = ctx.session.step || '';

    if (step.startsWith('awaiting_np_phone_')) {
        const parcelId = step.replace('awaiting_np_phone_', '');
        const phone = ctx.message?.text?.trim();
        if (phone && phone.match(/^\d{10,12}$/)) {
            const telegramId = ctx.from.id;
            const user = await prisma.user.findUnique({
                where: { telegramId: BigInt(telegramId) },
                include: { staffProfile: true }
            });
            if (user?.staffProfile) {
                await prisma.staffProfile.update({
                    where: { id: user.staffProfile.id },
                    data: { npPhone: phone }
                });
            }
            ctx.session.step = 'idle';
            const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcelId}`);
            await ctx.reply("Номер збережено! Натисни кнопку нижче, як забереш посилку.", { reply_markup: kb });
        } else {
            await ctx.reply("Будь ласка, введи коректний номер (наприклад, 380991234567).");
        }
        return;
    }

    if (step.startsWith('awaiting_parcel_photo_')) {
        const parcelId = step.replace('awaiting_parcel_photo_', '');
        const photo = ctx.message?.photo?.[ctx.message.photo.length - 1];
        
        if (photo) {
            const parcel = await prisma.parcel.update({
                where: { id: parcelId },
                data: { 
                    contentPhotoId: photo.file_id,
                    status: 'VERIFYING'
                },
                include: { location: true }
            });

            ctx.session.step = 'idle';
            await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_received);

            // Notify Support (English)
            const kb = new InlineKeyboard()
                .text("🖼 View Photo", `admin_parcel_view_${parcelId}`)
                .row()
                .text("✅ Everything is fine", `admin_parcel_confirm_${parcelId}`);

            const text = `📸 <b>New Content Photo Received!</b>\n\nParcel: <code>${parcel.ttn}</code>\nLocation: ${parcel.location?.name || 'Unknown'}\n\nPlease verify the contents.`;

            const options: any = { 
                parse_mode: 'HTML', 
                reply_markup: kb
            };
            if (TEAM_CHATS.LOGISTICS !== undefined) {
                options.message_thread_id = TEAM_CHATS.LOGISTICS;
            }

            await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, text, options);
        } else {
            await ctx.reply("Будь ласка, надішли саме фото. 📸");
        }
        return;
    }

    await next();
});
