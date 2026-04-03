import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import prisma from "../../../db/core.js";
import { LOGISTICS_TEXTS_STAFF, LOGISTICS_TEXTS_ADMIN } from "../../../constants/logistics-constants.js";
import { TEAM_CHATS } from "../../../config.js";
import logger from "../../../core/logger.js";
import { audit } from "../../../core/audit-logger.js";
import { sanitizeCallbackData } from "../../../core/log-sanitizer.js";

export const staffLogisticsHandlers = new Composer<MyContext>();

const PARCEL_PHOTO_REMINDER_MS = 1000 * 60 * 15;
const parcelPhotoReminderTimers = new Map<string, NodeJS.Timeout>();

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

function buildParcelPhotoDraftKeyboard(parcelId: string) {
    return new InlineKeyboard()
        .text(LOGISTICS_TEXTS_STAFF.btn_photo_done, `parcel_photo_done_${parcelId}`)
        .text(LOGISTICS_TEXTS_STAFF.btn_photo_cancel, `parcel_photo_cancel_${parcelId}`);
}

function getDraftParcelId(ctx: MyContext): string | null {
    return ctx.session.parcelPhotoDraft?.parcelId || null;
}

function getParcelPhotoReminderKey(ctx: MyContext) {
    const rawKey = ctx.chat?.id ?? ctx.from?.id;
    return rawKey !== undefined ? String(rawKey) : null;
}

function hasShipmentLockedMarker(value: string | null | undefined) {
    return /SHIPMENT_LOCKED|delivered to the recipient|further data changes are not possible/i.test(value || '');
}

function clearParcelPhotoReminder(ctx: MyContext) {
    const reminderKey = getParcelPhotoReminderKey(ctx);
    if (!reminderKey) return;

    const timer = parcelPhotoReminderTimers.get(reminderKey);
    if (timer) {
        clearTimeout(timer);
        parcelPhotoReminderTimers.delete(reminderKey);
    }
}

function scheduleParcelPhotoReminder(ctx: MyContext, parcelId: string) {
    const reminderKey = getParcelPhotoReminderKey(ctx);
    if (!reminderKey) return;

    clearParcelPhotoReminder(ctx);

    const timer = setTimeout(() => {
        const draft = ctx.session.parcelPhotoDraft;
        if (!draft || draft.parcelId !== parcelId || draft.fileIds.length === 0) {
            parcelPhotoReminderTimers.delete(reminderKey);
            return;
        }

        parcelPhotoReminderTimers.delete(reminderKey);

        void ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_reminder(draft.fileIds.length), {
            parse_mode: 'HTML',
            reply_markup: buildParcelPhotoDraftKeyboard(parcelId)
        }).catch((err) => {
            logger.warn({ err, parcelId, telegramId: ctx.from?.id }, "Failed to send parcel photo upload reminder");
        });
    }, PARCEL_PHOTO_REMINDER_MS);

    parcelPhotoReminderTimers.set(reminderKey, timer);
}

function resetParcelPhotoDraft(ctx: MyContext) {
    clearParcelPhotoReminder(ctx);
    delete ctx.session.parcelPhotoDraft;
    if (ctx.session.step.startsWith('awaiting_parcel_photo_')) {
        ctx.session.step = 'idle';
    }
}

async function sendParcelPhotosToSupport(ctx: MyContext, parcelId: string, photoFileIds: string[]) {
    const parcel = await prisma.parcel.findUnique({
        where: { id: parcelId },
        include: { location: true, responsibleStaff: true }
    });

    if (!parcel) {
        throw new Error(`Parcel ${parcelId} not found after photo upload`);
    }

    const kb = new InlineKeyboard()
        .text("✅ Everything is fine", `apc_${parcelId}`)
        .text("🗑 Delete", `apd_${parcelId}`);

    const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
        ttn: parcel.ttn,
        location: parcel.location?.name || 'Unknown',
        sender: parcel.responsibleStaff?.fullName || 'Photographer'
    });

    const threadOptions: Record<string, unknown> = {};
    if (TEAM_CHATS.LOGISTICS !== undefined) {
        threadOptions.message_thread_id = TEAM_CHATS.LOGISTICS;
    }

    try {
        if (photoFileIds.length === 1) {
            await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, photoFileIds[0]!, {
                caption,
                parse_mode: 'HTML',
                reply_markup: kb,
                ...threadOptions
            });
        } else {
            const media = photoFileIds.map((fileId, index) => ({
                type: 'photo' as const,
                media: fileId,
                ...(index === 0 ? { caption, parse_mode: 'HTML' as const } : {})
            }));

            await ctx.api.sendMediaGroup(TEAM_CHATS.SUPPORT, media, threadOptions);
            await ctx.api.sendMessage(
                TEAM_CHATS.SUPPORT,
                `⬆️ ${photoFileIds.length} photos for TTN <code>${parcel.ttn}</code>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: kb,
                    ...threadOptions
                }
            );
        }
    } catch (e: any) {
        if (e.description?.includes("thread not found")) {
            logger.warn({ logisticsThreadId: TEAM_CHATS.LOGISTICS }, "Logistics thread missing; falling back to general support chat");
            delete threadOptions.message_thread_id;

            if (photoFileIds.length === 1) {
                await ctx.api.sendPhoto(TEAM_CHATS.SUPPORT, photoFileIds[0]!, {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } else {
                const media = photoFileIds.map((fileId, index) => ({
                    type: 'photo' as const,
                    media: fileId,
                    ...(index === 0 ? { caption, parse_mode: 'HTML' as const } : {})
                }));

                await ctx.api.sendMediaGroup(TEAM_CHATS.SUPPORT, media);
                await ctx.api.sendMessage(
                    TEAM_CHATS.SUPPORT,
                    `⬆️ ${photoFileIds.length} photos for TTN <code>${parcel.ttn}</code>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    }
                );
            }
            return;
        }

        throw e;
    }
}

async function finalizeParcelPhotoDraft(ctx: MyContext, parcelId: string) {
    const draft = ctx.session.parcelPhotoDraft;
    if (!draft || draft.parcelId !== parcelId || draft.fileIds.length === 0) {
        await ctx.answerCallbackQuery(LOGISTICS_TEXTS_STAFF.photo_upload_empty);
        return;
    }

    audit({
        event: "parcel_photo_upload",
        result: "started",
        actorType: "staff",
        telegramId: ctx.from?.id,
        entityType: "parcel",
        entityId: parcelId,
        updateId: ctx.update.update_id,
        context: { photoCount: draft.fileIds.length }
    });

    try {
        const parcel = await prisma.parcel.findUnique({
            where: { id: parcelId },
            select: { contentPhotoIds: true }
        });

        const mergedPhotoIds = Array.from(new Set([
            ...(parcel?.contentPhotoIds || []),
            ...draft.fileIds
        ]));

        await prisma.parcel.update({
            where: { id: parcelId },
            data: {
                contentPhotoIds: mergedPhotoIds,
                status: 'VERIFYING'
            }
        });

        resetParcelPhotoDraft(ctx);

        await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_received(mergedPhotoIds.length));
        await sendParcelPhotosToSupport(ctx, parcelId, mergedPhotoIds);

        audit({
            event: "parcel_photo_upload",
            result: "success",
            actorType: "staff",
            telegramId: ctx.from?.id,
            entityType: "parcel",
            entityId: parcelId,
            updateId: ctx.update.update_id,
            context: { photoCount: draft.fileIds.length }
        });
    } catch (err: any) {
        audit({
            event: "parcel_photo_upload",
            result: "failed",
            actorType: "staff",
            telegramId: ctx.from?.id,
            entityType: "parcel",
            entityId: parcelId,
            updateId: ctx.update.update_id,
            error: err.message
        });
        logger.error({ err, parcelId, telegramId: ctx.from?.id }, "Logistics parcel photo upload handler failed");
        await editOrReplyText(ctx, "Не вдалося передати фото сапорту. Спробуй натиснути «Готово» ще раз або напиши в підтримку.");
    }
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
            include: { responsibleStaff: true, location: true }
        });

        if (!parcel) {
            await ctx.answerCallbackQuery("Parcel not found.");
            return;
        }

        if (parcel.status === 'DELIVERED') {
            const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, `parcel_photo_${parcelId}`);
            const locationName = parcel.location?.name || 'локації';
            const text = parcel.deliveryType === 'Address'
                ? LOGISTICS_TEXTS_STAFF.delivered_address(parcel.ttn, locationName)
                : LOGISTICS_TEXTS_STAFF.delivered_pickup_completed(parcel.ttn, locationName);

            await editOrReplyText(ctx, text, kb);
            await ctx.answerCallbackQuery("Посилку вже видано. Додай фото вмісту.");
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

    const { logisticsService } = await import("../../../services/logistics-service.js");
    await logisticsService.notifyTomorrowShiftAboutLeftover(parcelId).catch(err => {
        logger.error({ err, parcelId, telegramId: ctx.from?.id }, "Logistics next-shift leftover notification after reject failed");
    });

    if (newRejectionCount >= 2) {
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
        const trusteeResult = await novaPoshtaService.createTrustee(parcel.ttn, phoneToUse);
        if (!trusteeResult.success) {
            const shouldNotifySupport = !hasShipmentLockedMarker(parcel.npTrusteeError);
            await prisma.parcel.update({
                where: { id: parcelId },
                data: {
                    npTrusteeError: trusteeResult.errorMessage || trusteeResult.errorCode || 'Unknown API error',
                    npTrusteeLastAttemptAt: new Date()
                }
            });
            audit({ event: "parcel_phone_confirm", result: "failed", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });

            if (trusteeResult.errorCode === 'SHIPMENT_LOCKED') {
                const { logisticsService } = await import("../../../services/logistics-service.js");
                await logisticsService.handleShipmentLocked(parcelId, {
                    telegramId,
                    attemptedPhone: phoneToUse,
                    errorMessage: trusteeResult.errorMessage,
                    shouldNotifySupport,
                    source: 'parcel_phone_ok'
                });
                await editOrReplyText(
                    ctx,
                    "Нова Пошта вже перевела цю посилку у стан, де доручення через API більше не оформлюється. Ми вже позначили кейс для підтримки. Якщо посилка вже у тебе, додай фото вмісту. Якщо ні, напиши в підтримку."
                );
                await ctx.answerCallbackQuery("Доручення вже недоступне.");
            } else {
                const retryKb = new InlineKeyboard()
                    .text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`).row()
                    .text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

                await editOrReplyText(
                    ctx,
                    "Не вдалося оформити доручення в Новій Пошті. Спробуй ще раз або зміни номер. Якщо помилка повториться, напиши в підтримку.",
                    retryKb
                );
                await ctx.answerCallbackQuery("Доручення не створено.");
            }
            return;
        }

        await prisma.parcel.update({
            where: { id: parcelId },
            data: {
                recipientPhone: phoneToUse,
                npTrusteeOrderRef: trusteeResult.orderRef || null,
                npTrusteeOrderNumber: trusteeResult.orderNumber || null,
                npTrusteeError: null,
                npTrusteeLastAttemptAt: new Date()
            }
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
// Exclude the "done" and "cancel" callbacks so they reach their dedicated handlers.
staffLogisticsHandlers.callbackQuery(/^parcel_photo_(?!done(?:_|$)|cancel(?:_|$))(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    ctx.session.step = `awaiting_parcel_photo_${parcelId}`;
    ctx.session.parcelPhotoDraft = {
        parcelId,
        fileIds: [],
        startedAt: Date.now()
    };
    scheduleParcelPhotoReminder(ctx, parcelId);
    await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_prompt, {
        parse_mode: 'HTML',
        reply_markup: buildParcelPhotoDraftKeyboard(parcelId)
    });
    await ctx.answerCallbackQuery();
});

staffLogisticsHandlers.callbackQuery(/^parcel_photo_done_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    await ctx.answerCallbackQuery("Завершую відправку фото...");
    await finalizeParcelPhotoDraft(ctx, parcelId);
});

staffLogisticsHandlers.callbackQuery("parcel_photo_done", async (ctx) => {
    const parcelId = getDraftParcelId(ctx);
    if (!parcelId) {
        await ctx.answerCallbackQuery("Активне завантаження вже завершене.");
        return;
    }

    await ctx.answerCallbackQuery("Завершую відправку фото...");
    await finalizeParcelPhotoDraft(ctx, parcelId);
});

staffLogisticsHandlers.callbackQuery(/^parcel_photo_cancel_(.+)$/, async (ctx) => {
    const parcelId = ctx.match[1] as string;
    const draft = ctx.session.parcelPhotoDraft;

    if (!draft || draft.parcelId !== parcelId) {
        await ctx.answerCallbackQuery("Активне завантаження вже завершене.");
        return;
    }

    resetParcelPhotoDraft(ctx);
    await ctx.answerCallbackQuery("Скасовано.");
    await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_upload_cancelled);
});

staffLogisticsHandlers.callbackQuery("parcel_photo_cancel", async (ctx) => {
    const parcelId = getDraftParcelId(ctx);
    if (!parcelId) {
        await ctx.answerCallbackQuery("Активне завантаження вже завершене.");
        return;
    }

    resetParcelPhotoDraft(ctx);
    await ctx.answerCallbackQuery("Скасовано.");
    await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_upload_cancelled);
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
                const trusteeResult = await novaPoshtaService.createTrustee(parcel.ttn, phone);
                if (!trusteeResult.success) {
                    const shouldNotifySupport = !hasShipmentLockedMarker(parcel.npTrusteeError);
                    await prisma.parcel.update({
                        where: { id: parcelId },
                        data: {
                            npTrusteeError: trusteeResult.errorMessage || trusteeResult.errorCode || 'Unknown API error',
                            npTrusteeLastAttemptAt: new Date()
                        }
                    });
                    if (trusteeResult.errorCode === 'SHIPMENT_LOCKED') {
                        const { logisticsService } = await import("../../../services/logistics-service.js");
                        await logisticsService.handleShipmentLocked(parcelId, {
                            telegramId,
                            attemptedPhone: phone,
                            errorMessage: trusteeResult.errorMessage,
                            shouldNotifySupport,
                            source: 'parcel_phone_change'
                        });
                        await ctx.reply(
                            "Номер збережено, але Нова Пошта вже не дозволяє оформити доручення для цієї посилки через API. Ми вже позначили кейс для підтримки. Якщо посилка вже у тебе, додай фото вмісту. Якщо ні, напиши в підтримку."
                        );
                    } else {
                        const retryKb = new InlineKeyboard()
                            .text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, `parcel_phone_ok_${parcelId}`).row()
                            .text(LOGISTICS_TEXTS_STAFF.btn_change_phone, `parcel_phone_change_${parcelId}`);

                        await ctx.reply(
                            "Номер збережено, але доручення в Новій Пошті не створилося. Спробуй ще раз або зміни номер. Якщо помилка повториться, напиши в підтримку.",
                            { reply_markup: retryKb }
                        );
                    }
                    audit({ event: "parcel_phone_confirm", result: "failed", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });
                    return;
                }

                await prisma.parcel.update({
                    where: { id: parcelId },
                    data: {
                        recipientPhone: phone,
                        npTrusteeOrderRef: trusteeResult.orderRef || null,
                        npTrusteeOrderNumber: trusteeResult.orderNumber || null,
                        npTrusteeError: null,
                        npTrusteeLastAttemptAt: new Date()
                    }
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
        const draft = ctx.session.parcelPhotoDraft;
        const photo = ctx.message?.photo?.[ctx.message.photo.length - 1];

        if (!draft || draft.parcelId !== parcelId) {
            ctx.session.parcelPhotoDraft = {
                parcelId,
                fileIds: [],
                startedAt: Date.now()
            };
        }

        if (photo) {
            const currentDraft = ctx.session.parcelPhotoDraft!;
            if (!currentDraft.fileIds.includes(photo.file_id)) {
                currentDraft.fileIds.push(photo.file_id);
            }
            currentDraft.lastPhotoAt = Date.now();
            scheduleParcelPhotoReminder(ctx, parcelId);

            await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_progress(currentDraft.fileIds.length), {
                parse_mode: 'HTML',
                reply_markup: buildParcelPhotoDraftKeyboard(parcelId)
            });
        } else {
            await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_waiting, {
                parse_mode: 'HTML',
                reply_markup: buildParcelPhotoDraftKeyboard(parcelId)
            });
        }
        return;
    }

    await next();
});
