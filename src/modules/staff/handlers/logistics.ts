import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import prisma from "../../../db/core.js";
import { LOGISTICS_TEXTS_STAFF, LOGISTICS_TEXTS_ADMIN } from "../../../constants/logistics-constants.js";
import { TEAM_CHATS } from "../../../config.js";
import logger from "../../../core/logger.js";
import { audit } from "../../../core/audit-logger.js";
import { sanitizeCallbackData } from "../../../core/log-sanitizer.js";

export const staffLogisticsHandlers = new Composer<MyContext>();

async function editOrReplyText(
    ctx: MyContext,
    text: string,
    replyMarkup?: InlineKeyboard,
) {
    const options = replyMarkup
        ? { parse_mode: 'HTML' as const, reply_markup: replyMarkup }
        : { parse_mode: 'HTML' as const };

    if (ctx.callbackQuery?.message && !('photo' in ctx.callbackQuery.message)) {
        try {
            await ctx.editMessageText(text, options);
            return;
        } catch (err) {
            logger.warn({
                err,
                callbackAction: sanitizeCallbackData(ctx.callbackQuery.data),
                telegramId: ctx.from?.id
            }, "Logistics message edit failed; falling back to reply");
        }
    }

    await ctx.reply(text, options);
}

// 1. Accept Parcel
staffLogisticsHandlers.callbackQuery(/^parcel_accept_(.+)$/, async (ctx) => {
    try {
        const parcelId = ctx.match[1] as string;
        const telegramId = ctx.from?.id;
        if (!telegramId) {
            await ctx.answerCallbackQuery("Не вдалося визначити користувача.");
            return;
        }

        audit({ event: "parcel_accept", result: "started", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

        const user = await prisma.user.findUnique({
            where: { telegramId: BigInt(telegramId) },
            include: { staffProfile: true }
        });

        if (!user || !user.staffProfile) {
            await ctx.answerCallbackQuery("Профіль фотографа не знайдено.");
            return;
        }

        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            include: { responsibleStaff: true }
        });

        if (!parcel) {
            await ctx.answerCallbackQuery("Parcel not found.");
            return;
        }

        if (parcel.responsibleStaffId && parcel.responsibleStaffId !== user.staffProfile.id) {
            await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.already_taken(parcel.responsibleStaff?.fullName || 'another photographer'));
            await ctx.answerCallbackQuery("Цю посилку вже взяли.");
            return;
        }

        await prisma.parcel.update({
            where: { id: parcelId },
            data: {
                responsibleStaffId: user.staffProfile.id,
                status: 'PICKUP_IN_PROGRESS',
                acceptedAt: new Date()
            }
        });

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

        await editOrReplyText(ctx, askText, kb);
        await ctx.answerCallbackQuery("Прийнято.");

        audit({ event: "parcel_accept", result: "success", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, actorId: user.staffProfile.id });
    } catch (err: any) {
        audit({ event: "parcel_accept", result: "failed", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: ctx.match?.[1], updateId: ctx.update.update_id, error: err.message });
        logger.error({ err, parcelId: ctx.match?.[1], telegramId: ctx.from?.id }, "Logistics parcel accept handler failed");
        await ctx.answerCallbackQuery({ text: "Не вдалося обробити кнопку. Спробуй ще раз.", show_alert: true }).catch(() => { });
    }
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

    audit({ event: "parcel_reject", result: "success", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, context: { rejectionCount: newRejectionCount } });

    const text = `Окей, дякую! 📦\nЦя посилка залишається у списку локації, її зможе забрати інша фотографиня. ✨`;
    await editOrReplyText(ctx, text);
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
        const trusteeCreated = await novaPoshtaService.createTrustee(parcel.ttn, phoneToUse);
        if (!trusteeCreated) {
            audit({ event: "parcel_phone_confirm", result: "failed", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

            const retryKb = new InlineKeyboard()
                .text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`).row()
                .text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

            await editOrReplyText(
                ctx,
                "Не вдалося оформити доручення в Новій Пошті. Спробуй ще раз або зміни номер. Якщо помилка повториться, напиши в підтримку.",
                retryKb
            );
            await ctx.answerCallbackQuery("Доручення не створено.");
            return;
        }

        await prisma.parcel.update({
            where: { id: parcelId },
            data: { recipientPhone: phoneToUse }
        });
    }

    audit({ event: "parcel_phone_confirm", result: "success", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

    const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcelId}`);

    await editOrReplyText(
        ctx,
        "Чудово! API-запит на оформлення доручення відправлено. Якщо виникнуть проблеми з відкриттям комірки у додатку НП — пиши в підтримку.\n\nНатисни кнопку нижче, коли забереш посилку та сфотографуєш її вміст. ✨",
        kb
    );
    await ctx.answerCallbackQuery();
});

// 4. Change Phone
staffLogisticsHandlers.callbackQuery(/^parcel_phone_change_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    ctx.session.step = `awaiting_np_phone_${parcelId}`;
    audit({ event: "parcel_phone_change", result: "started", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });
    await editOrReplyText(ctx, "Будь ласка, введи номер телефону для оформлення доручення (у форматі 380...):");
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
                const trusteeCreated = await novaPoshtaService.createTrustee(parcel.ttn, phone);
                if (!trusteeCreated) {
                    const retryKb = new InlineKeyboard()
                        .text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`).row()
                        .text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

                    await ctx.reply(
                        "Номер збережено, але доручення в Новій Пошті не створилося. Спробуй ще раз або зміни номер. Якщо помилка повториться, напиши в підтримку.",
                        { reply_markup: retryKb }
                    );
                    audit({ event: "parcel_phone_confirm", result: "failed", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });
                    return;
                }

                await prisma.parcel.update({
                    where: { id: parcelId },
                    data: { recipientPhone: phone }
                });
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
            audit({ event: "parcel_photo_upload", result: "started", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });
            try {
                await prisma.parcel.update({
                    where: { id: parcelId },
                    data: { 
                        contentPhotoIds: {
                            push: photo.file_id
                        },
                        status: 'VERIFYING'
                    }
                });

                const parcel = await prisma.parcel.findUnique({
                    where: { id: parcelId },
                    include: { location: true, responsibleStaff: true }
                });

                if (!parcel) {
                    throw new Error(`Parcel ${parcelId} not found after photo upload`);
                }

                ctx.session.step = 'idle';
                await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_received);

                audit({ event: "parcel_photo_upload", result: "success", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

                const kb = new InlineKeyboard()
                    .text("✅ Everything is fine", `admin_parcel_confirm_direct_${parcelId}`)
                    .text("🗑 Delete", `admin_parcel_delete_direct_${parcelId}`);

                const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
                    ttn: parcel.ttn,
                    location: parcel.location?.name || 'Unknown',
                    sender: parcel.responsibleStaff?.fullName || 'Photographer'
                });

                const options: any = { 
                    caption,
                    parse_mode: 'HTML', 
                    reply_markup: kb
                };
                
                if (TEAM_CHATS.LOGISTICS !== undefined) {
                    options.message_thread_id = TEAM_CHATS.LOGISTICS;
                }

                // Send to Support Chat (with fallback for thread)
                try {
                    await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, photo.file_id, options);
                } catch (e: any) {
                    if (e.description?.includes("thread not found")) {
                        logger.warn({ logisticsThreadId: TEAM_CHATS.LOGISTICS }, "Logistics thread missing; falling back to general support chat");
                        delete options.message_thread_id;
                        await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, photo.file_id, options).catch(err => {
                            logger.error({ err, parcelId }, "Logistics parcel photo delivery failed in fallback channel");
                        });
                    } else {
                        throw e;
                    }
                }
            } catch (err: any) {
                audit({ event: "parcel_photo_upload", result: "failed", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, error: err.message });
                logger.error({ err, parcelId, telegramId: ctx.from?.id }, "Logistics parcel photo upload handler failed");
                throw err;
            }
        } else {
            await ctx.reply("Будь ласка, надішли саме фото. 📸");
        }
        return;
    }

    await next();
});
