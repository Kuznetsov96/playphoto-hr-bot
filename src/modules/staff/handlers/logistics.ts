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

    // Ask for phone confirmation and format to 12 digits minimum (e.g. 380...)
    let phoneToUse = (user.staffProfile.npPhone || user.staffProfile.phone || '').replace(/\D/g, '');
    if (phoneToUse.length === 10 && phoneToUse.startsWith('0')) {
        phoneToUse = '38' + phoneToUse;
    }
    const isValid = phoneToUse.length === 12 && phoneToUse.startsWith('380');

    const kb = new InlineKeyboard();
    if (isValid) {
        kb.text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`).row();
    }
    kb.text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

    const askText = isValid 
        ? LOGISTICS_TEXTS_STAFF.ask_phone(`+${phoneToUse}`)
        : `⚠️ <b>Номер телефону відсутній або некоректний.</b>\nДля створення повноцінного доручення Нової Пошти потрібен правильний номер (380...).\n\nБудь ласка, оберіть «Змінити номер» і введіть його.`;

    await ctx.editMessageText(askText, {
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

    if (newRejectionCount >= 2) {
        const { logisticsService } = await import("../../../services/logistics-service.js");
        await logisticsService.notifySupport(parcelId, 'REJECTED');
    }

    const text = `Окей, дякую! 📦\nЦя посилка залишається у списку локації, її зможе забрати інша фотографиня. ✨`;
    await ctx.editMessageText(text, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();
});

// 3. Confirm Phone
staffLogisticsHandlers.callbackQuery(/^parcel_phone_ok_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        include: { staffProfile: true }
    });

    let phoneToUse = (user?.staffProfile?.npPhone || user?.staffProfile?.phone || '').replace(/\D/g, '');
    if (phoneToUse.length === 10 && phoneToUse.startsWith('0')) phoneToUse = '38' + phoneToUse;

    const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
    if (parcel && phoneToUse.length === 12 && phoneToUse.startsWith('380')) {
        const { novaPoshtaService } = await import("../../../services/nova-poshta-service.js");
        await novaPoshtaService.createTrustee(parcel.ttn, phoneToUse, user?.staffProfile?.fullName);
    }

    const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcelId}`);

    await ctx.editMessageText("Чудово! API-запит на оформлення доручення відправлено. Якщо виникнуть проблеми з відкриттям комірки у додатку НП — пиши в підтримку.\n\nНатисни кнопку нижче, коли забереш посилку та сфотографуєш її вміст. ✨", {
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
    await ctx.reply("Будь ласка, надішли фото вмісту посилки 📸\nМожеш надіслати кілька фото — по одному. Коли закінчиш, натисни «Готово».");
    await ctx.answerCallbackQuery();
});

// 6. Photo upload done — finalize and notify support
staffLogisticsHandlers.callbackQuery(/^parcel_photo_done_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    ctx.session.step = 'idle';

    const parcel = await prisma.parcel.update({
        where: { id: parcelId },
        data: { status: 'VERIFYING' },
        include: { location: true, responsibleStaff: true }
    });

    if (parcel.contentPhotoIds.length === 0) {
        await ctx.answerCallbackQuery("No photos uploaded yet.");
        return;
    }

    await ctx.editMessageText(LOGISTICS_TEXTS_STAFF.photo_received, { parse_mode: 'HTML' });
    await ctx.answerCallbackQuery();

    // Send photos to support chat
    const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
        ttn: parcel.ttn,
        location: parcel.location?.name || 'Unknown',
        sender: parcel.responsibleStaff?.fullName || 'Photographer'
    });

    const kb = new InlineKeyboard()
        .text("✅ Everything is fine", `admin_parcel_confirm_direct_${parcelId}`)
        .text("🗑 Delete", `admin_parcel_delete_direct_${parcelId}`);

    const threadOptions: any = {};
    if (TEAM_CHATS.LOGISTICS !== undefined) {
        threadOptions.message_thread_id = TEAM_CHATS.LOGISTICS;
    }

    if (parcel.contentPhotoIds.length === 1) {
        await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, parcel.contentPhotoIds[0]!, {
            caption, parse_mode: 'HTML', reply_markup: kb, ...threadOptions
        });
    } else {
        const media = parcel.contentPhotoIds.map((id: string, i: number) => ({
            type: 'photo' as const,
            media: id,
            ...(i === 0 ? { caption, parse_mode: 'HTML' as const } : {})
        }));
        await ctx.api.sendMediaGroup(TEAM_CHATS.SUPPORT, media, threadOptions);
        await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, `⬆️ ${parcel.contentPhotoIds.length} photos for TTN <code>${parcel.ttn}</code>`, {
            parse_mode: 'HTML', reply_markup: kb, ...threadOptions
        });
    }
});

// Handle text and photo inputs
staffLogisticsHandlers.on("message", async (ctx, next) => {
    const step = ctx.session.step || '';

    if (step.startsWith('awaiting_np_phone_')) {
        const parcelId = step.replace('awaiting_np_phone_', '');
        const rawText = ctx.message?.text?.trim() || '';
        let phone = rawText.replace(/\D/g, ''); // Extract only digits

        if (phone.length === 10 && phone.startsWith('0')) {
            phone = '38' + phone;
        }

        if (phone.length === 12 && phone.startsWith('380')) {
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
            
            // Auto-trigger the API request if we just saved the phone.
            const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
            if (parcel) {
                const { novaPoshtaService } = await import("../../../services/nova-poshta-service.js");
                await novaPoshtaService.createTrustee(parcel.ttn, phone, user?.staffProfile?.fullName);
            }

            await ctx.reply("Номер збережено і API-запит відправлено! Натисни кнопку нижче, як забереш посилку та зробиш фото. ✨", { reply_markup: kb });
        } else {
            await ctx.reply("⚠️ Некоректний формат.\nБудь ласка, введіть номер телефону в форматі 380... (наприклад: 380991234567).");
        }
        return;
    }

    if (step.startsWith('awaiting_parcel_photo_')) {
        const parcelId = step.replace('awaiting_parcel_photo_', '');
        const photo = ctx.message?.photo?.[ctx.message.photo.length - 1];

        if (photo) {
            const telegramId = ctx.from?.id;
            const uploader = telegramId ? await prisma.user.findUnique({
                where: { telegramId: BigInt(telegramId) },
                include: { staffProfile: true }
            }) : null;

            // Append photo to array (accumulate multiple photos)
            await prisma.parcel.update({
                where: { id: parcelId },
                data: {
                    contentPhotoIds: { push: photo.file_id },
                    ...(uploader?.staffProfile ? { responsibleStaffId: uploader.staffProfile.id } : {})
                }
            });

            const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
            const count = parcel?.contentPhotoIds.length || 1;

            const kb = new InlineKeyboard()
                .text('✅ Готово', `parcel_photo_done_${parcelId}`);

            await ctx.reply(`Фото ${count} збережено! Надішли ще або натисни «Готово». 📸`, { reply_markup: kb });
        } else {
            await ctx.reply("Будь ласка, надішли саме фото. 📸");
        }
        return;
    }

    await next();
});
