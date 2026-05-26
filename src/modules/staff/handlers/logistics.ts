import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../../types/context.js";
import prisma from "../../../db/core.js";
import { LOGISTICS_TEXTS_STAFF, LOGISTICS_TEXTS_ADMIN } from "../../../constants/logistics-constants.js";
import { TEAM_CHATS } from "../../../config.js";
import logger from "../../../core/logger.js";
import { audit } from "../../../core/audit-logger.js";
import { logBusinessEvent } from "../../../core/log-events.js";
import { sanitizeCallbackData } from "../../../core/log-sanitizer.js";
import { formatLogisticsLocation, formatLogisticsPhotographerName } from "../../../utils/logistics-formatters.js";
import { buildSignedCallback, readCallbackPayload } from "../../../utils/signed-callback.js";
import {
    getManualProxyConfirmationText,
    getParcelRejectConfirmationText,
    isDuplicateParcelAccept,
    isDuplicateParcelReject,
    shouldEscalateRejectedParcel,
} from "./logistics-rejection.js";

export const staffLogisticsHandlers = new Composer<MyContext>();

const PARCEL_PHOTO_REMINDER_MS = 1000 * 60 * 15;
const PARCEL_PHOTO_CANCEL_GRACE_MS = 1000 * 60 * 5;
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

async function clearCallbackKeyboard(ctx: MyContext) {
    if (!ctx.callbackQuery?.message || ('photo' in ctx.callbackQuery.message)) return;

    await ctx.editMessageReplyMarkup().catch(() => { });
}

function buildParcelPhotoDraftKeyboard(parcelId: string) {
    return new InlineKeyboard()
        .text(LOGISTICS_TEXTS_STAFF.btn_photo_done, buildSignedCallback("ppd", parcelId))
        .text(LOGISTICS_TEXTS_STAFF.btn_photo_cancel, buildSignedCallback("ppx", parcelId));
}

function buildParcelPhotoRestartKeyboard(parcelId: string) {
    return new InlineKeyboard()
        .text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcelId));
}

function getDraftParcelId(ctx: MyContext): string | null {
    return ctx.session.parcelPhotoDraft?.parcelId || null;
}

function getParcelPhotoReminderKey(ctx: MyContext) {
    const rawKey = ctx.chat?.id ?? ctx.from?.id;
    return rawKey !== undefined ? String(rawKey) : null;
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

function resetParcelPhotoDraft(ctx: MyContext, options?: { cancelled?: boolean }) {
    const draft = ctx.session.parcelPhotoDraft;
    clearParcelPhotoReminder(ctx);
    delete ctx.session.parcelPhotoDraft;
    if (options?.cancelled && draft) {
        ctx.session.parcelPhotoCancelledDraft = {
            parcelId: draft.parcelId,
            cancelledAt: Date.now(),
        };
    } else if (!options?.cancelled) {
        delete ctx.session.parcelPhotoCancelledDraft;
    }
    if (ctx.session.step.startsWith('awaiting_parcel_photo_')) {
        ctx.session.step = 'idle';
    }
}

function getRecentlyCancelledParcelPhotoId(ctx: MyContext) {
    const cancelled = ctx.session.parcelPhotoCancelledDraft;
    if (!cancelled) return null;

    if (Date.now() - cancelled.cancelledAt > PARCEL_PHOTO_CANCEL_GRACE_MS) {
        delete ctx.session.parcelPhotoCancelledDraft;
        return null;
    }

    return cancelled.parcelId;
}

async function getAuthorizedParcelForStaff(ctx: MyContext, parcelId: string, options?: { allowUnassigned?: boolean }) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return null;

    const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        include: { staffProfile: true }
    });
    if (!user?.staffProfile) return null;

    const parcel = await prisma.parcel.findUnique({
        where: { id: parcelId },
        include: { responsibleStaff: true, location: true }
    });
    if (!parcel) return null;

    const ownsParcel = parcel.responsibleStaffId === user.staffProfile.id;
    const canUseUnassigned = Boolean(options?.allowUnassigned && !parcel.responsibleStaffId);
    if (!ownsParcel && !canUseUnassigned) {
        await ctx.answerCallbackQuery("Ця посилка закріплена за іншою фотографинею.").catch(() => { });
        return null;
    }

    return { user, parcel };
}

async function claimParcelForPhotoFlow(parcelId: string, staffId: string) {
    return prisma.parcel.update({
        where: {
            id: parcelId,
            responsibleStaffId: null,
            status: 'DELIVERED',
        },
        data: {
            responsibleStaffId: staffId,
            acceptedAt: new Date(),
        },
        include: { responsibleStaff: true, location: true }
    });
}

async function sendParcelPhotosToSupport(ctx: MyContext, parcelId: string, photoFileIds: string[]) {
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

    if (!parcel) {
        throw new Error(`Parcel ${parcelId} not found after photo upload`);
    }

    const kb = new InlineKeyboard()
        .text("✅ Everything is fine", `apc_${parcelId}`)
        .text("🗑 Delete", `apd_${parcelId}`);

    const caption = LOGISTICS_TEXTS_ADMIN.new_photo_caption({
        ttn: parcel.ttn,
        location: formatLogisticsLocation(parcel.location),
        sender: formatLogisticsPhotographerName(parcel.responsibleStaff)
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
    const access = await getAuthorizedParcelForStaff(ctx, parcelId);
    if (!access) return;
    const draft = ctx.session.parcelPhotoDraft;
    if (!draft || draft.parcelId !== parcelId || draft.fileIds.length === 0) {
        logBusinessEvent({
            event: "logistics.parcel.photo_upload_done_without_photos",
            actorType: "staff",
            actorRole: "staff",
            telegramId: ctx.from?.id,
            result: "failed",
            module: "staff-logistics-handler",
            operation: "finalizeParcelPhotoDraft",
            safeContext: {
                parcelId,
                draftExists: Boolean(draft),
                draftPhotoCount: draft?.fileIds.length ?? 0,
            },
        });
        await ctx.answerCallbackQuery(LOGISTICS_TEXTS_STAFF.photo_upload_empty);
        await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_upload_empty, buildParcelPhotoDraftKeyboard(parcelId));
        return;
    }

    logBusinessEvent({
        event: "logistics.parcel.photo_upload_finalize_started",
        actorType: "staff",
        actorRole: "staff",
        telegramId: ctx.from?.id,
        result: "started",
        module: "staff-logistics-handler",
        operation: "finalizeParcelPhotoDraft",
        safeContext: {
            parcelId,
            photoCount: draft.fileIds.length,
        },
    });

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

        logBusinessEvent({
            event: "logistics.parcel.photo_upload_finalized",
            actorType: "staff",
            actorRole: "staff",
            telegramId: ctx.from?.id,
            result: "success",
            module: "staff-logistics-handler",
            operation: "finalizeParcelPhotoDraft",
            safeContext: {
                parcelId,
                photoCount: mergedPhotoIds.length,
            },
        });

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
        logBusinessEvent({
            event: "logistics.parcel.photo_upload_finalized",
            actorType: "staff",
            actorRole: "staff",
            telegramId: ctx.from?.id,
            result: "failed",
            module: "staff-logistics-handler",
            operation: "finalizeParcelPhotoDraft",
            safeContext: {
                parcelId,
                photoCount: draft.fileIds.length,
            },
            error: err,
        });
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

        await ctx.answerCallbackQuery({ text: "Фіксую, що ти забираєш посилку…" }).catch(() => { });
        await clearCallbackKeyboard(ctx);

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
            const kb = new InlineKeyboard().text(LOGISTICS_TEXTS_STAFF.btn_photo, buildSignedCallback("pph", parcelId));
            const locationName = parcel.location?.name || 'локації';
            const text = parcel.deliveryType === 'Address'
                ? LOGISTICS_TEXTS_STAFF.delivered_address(parcel.ttn, locationName)
                : LOGISTICS_TEXTS_STAFF.delivered_pickup_completed(parcel.ttn, locationName);

            await editOrReplyText(ctx, text, kb);
            return;
        }

        if (parcel.responsibleStaffId && parcel.responsibleStaffId !== user.staffProfile.id) {
            await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.already_taken(parcel.responsibleStaff?.fullName || 'another photographer'));
            return;
        }

        const now = new Date();
        let alreadyAcceptedByThisStaff = parcel.responsibleStaffId === user.staffProfile.id;
        if (!alreadyAcceptedByThisStaff) {
            const claimed = await prisma.parcel.updateMany({
                where: {
                    id: parcelId,
                    responsibleStaffId: null,
                    status: { not: 'DELIVERED' },
                },
                data: {
                    responsibleStaffId: user.staffProfile.id,
                    status: 'PICKUP_IN_PROGRESS',
                    acceptedAt: now
                }
            });

            alreadyAcceptedByThisStaff = claimed.count === 0;
        }

        if (alreadyAcceptedByThisStaff && isDuplicateParcelAccept(parcel.acceptedAt, now)) {
            await editOrReplyText(ctx, "✅ <b>Посилку вже закріплено за тобою.</b>\n\nПовторно натискати не потрібно. Перевір номер телефону нижче, щоб продовжити оформлення.");
        }

        let phoneToUse = (user.staffProfile.npPhone || user.staffProfile.phone || '').replace(/\D/g, '');
        if (phoneToUse.length === 10 && phoneToUse.startsWith('0')) {
            phoneToUse = '38' + phoneToUse;
        }
        const isValid = phoneToUse.length === 12 && phoneToUse.startsWith('380');

        const kb = new InlineKeyboard();
        if (isValid) {
            kb.text(LOGISTICS_TEXTS_STAFF.btn_confirm_phone, buildSignedCallback("ppo", parcelId)).row();
        }
        kb.text(LOGISTICS_TEXTS_STAFF.btn_change_phone, buildSignedCallback("ppc", parcelId));

        const askText = isValid
            ? LOGISTICS_TEXTS_STAFF.ask_phone(`+${phoneToUse}`)
            : `⚠️ <b>Номер телефону відсутній або некоректний.</b>\nДля створення повноцінного доручення Нової Пошти потрібен правильний номер (380...).\n\nБудь ласка, оберіть «Змінити номер» і введіть його.`;

        await editOrReplyText(ctx, askText, kb);

        audit({ event: "parcel_accept", result: "success", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, actorId: user.staffProfile.id });
    } catch (err: any) {
        audit({ event: "parcel_accept", result: "failed", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: ctx.match?.[1], updateId: ctx.update.update_id, error: err.message });
        logger.error({ err, parcelId: ctx.match?.[1], telegramId: ctx.from?.id }, "Logistics parcel accept handler failed");
        await ctx.answerCallbackQuery({ text: "Не вдалося обробити кнопку. Спробуй ще раз.", show_alert: true }).catch(() => { });
    }
});

// 2. Reject Parcel
staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "prj" });
    if (!parcelId) return next();
    await ctx.answerCallbackQuery({ text: "Фіксую відмову…" }).catch(() => { });
    await clearCallbackKeyboard(ctx);
    const access = await getAuthorizedParcelForStaff(ctx, parcelId, { allowUnassigned: true });
    if (!access) return;
    const { parcel } = access;

    const now = new Date();
    const alreadyProcessed = isDuplicateParcelReject(parcel.lastRejectionAt, now);
    let newRejectionCount = parcel.rejectionCount;

    if (!alreadyProcessed) {
        const updateResult = await prisma.parcel.updateMany({
            where: {
                id: parcelId,
                rejectionCount: parcel.rejectionCount,
                lastRejectionAt: parcel.lastRejectionAt,
            },
            data: {
                rejectionCount: { increment: 1 },
                lastRejectionAt: now,
            }
        });

        if (updateResult.count > 0) {
            newRejectionCount = parcel.rejectionCount + 1;

            const { logisticsService } = await import("../../../services/logistics-service.js");
            await logisticsService.notifyTomorrowShiftAboutLeftover(parcelId).catch(err => {
                logger.error({ err, parcelId, telegramId: ctx.from?.id }, "Logistics next-shift leftover notification after reject failed");
            });

            if (shouldEscalateRejectedParcel(parcel.rejectionCount, newRejectionCount)) {
                await logisticsService.notifySupport(parcelId, 'REJECTED');
            }

            audit({ event: "parcel_reject", result: "success", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, context: { rejectionCount: newRejectionCount } });
        }
    }

    if (newRejectionCount === parcel.rejectionCount) {
        audit({ event: "parcel_reject", result: "success", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, context: { rejectionCount: parcel.rejectionCount, duplicateTap: true } });
    }

    const text = getParcelRejectConfirmationText(newRejectionCount === parcel.rejectionCount);
    await editOrReplyText(ctx, text);
});

// 3. Confirm Phone
staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "ppo" });
    if (!parcelId) return next();
    const telegramId = ctx.from?.id;
    if (!telegramId) return;
    await ctx.answerCallbackQuery({ text: "Передаю номер сапорту…" }).catch(() => { });
    await clearCallbackKeyboard(ctx);
    const access = await getAuthorizedParcelForStaff(ctx, parcelId);
    if (!access) return;
    const { user, parcel } = access;

    let phoneToUse = (user?.staffProfile?.npPhone || user?.staffProfile?.phone || '').replace(/\D/g, '');
    if (phoneToUse.length === 10 && phoneToUse.startsWith('0')) phoneToUse = '38' + phoneToUse;
    if (parcel && phoneToUse.length === 12 && phoneToUse.startsWith('380')) {
        const { logisticsService } = await import("../../../services/logistics-service.js");
        const result = await logisticsService.requestManualProxy(parcelId, {
            telegramId,
            requestedPhone: phoneToUse,
        });

        audit({ event: "parcel_phone_confirm", result: "success", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, context: { duplicateTap: Boolean(result?.duplicate) } });
        await editOrReplyText(ctx, getManualProxyConfirmationText(Boolean(result?.duplicate)));
        return;
    }

    audit({ event: "parcel_phone_confirm", result: "failed", actorType: "staff", telegramId, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id, error: "INVALID_PHONE" });
    await editOrReplyText(ctx, "⚠️ Не вдалося використати цей номер для доручення. Обери «Інший номер» і введи коректний телефон у форматі 380...");
});

// 4. Change Phone
staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "ppc" });
    if (!parcelId) return next();
    const access = await getAuthorizedParcelForStaff(ctx, parcelId);
    if (!access) return;
    ctx.session.step = `awaiting_np_phone_${parcelId}`;
    audit({ event: "parcel_phone_change", result: "started", actorType: "staff", telegramId: ctx.from?.id, entityType: "parcel", entityId: parcelId, updateId: ctx.update.update_id });
    await editOrReplyText(ctx, "Будь ласка, введи номер телефону для оформлення доручення (у форматі 380...):");
    await ctx.answerCallbackQuery();
});

// 5. Trigger Photo Upload
// Exclude the "done" and "cancel" callbacks so they reach their dedicated handlers.
staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "pph" });
    if (!parcelId) return next();
    const access = await getAuthorizedParcelForStaff(ctx, parcelId, { allowUnassigned: true });
    if (!access) return;
    const { user, parcel } = access;
    const staffProfile = user.staffProfile!;

    if (!parcel.responsibleStaffId && parcel.status === 'DELIVERED') {
        try {
            const claimedParcel = await claimParcelForPhotoFlow(parcelId, staffProfile.id);
            logBusinessEvent({
                event: "logistics.parcel.photo_flow_claimed_unassigned",
                actorType: "staff",
                actorRole: "staff",
                telegramId: ctx.from?.id,
                result: "success",
                module: "staff-logistics-handler",
                operation: "parcel_photo_callback",
                safeContext: {
                    parcelId,
                    staffId: staffProfile.id,
                    previousResponsibleStaffId: null,
                    newResponsibleStaffId: claimedParcel.responsibleStaffId,
                },
            });
        } catch (err: any) {
            // Another staff member may have claimed it just before this callback.
            const refreshedAccess = await getAuthorizedParcelForStaff(ctx, parcelId);
            if (!refreshedAccess) {
                logger.warn({ err, parcelId, telegramId: ctx.from?.id }, "Failed to claim parcel for photo flow");
                return;
            }
        }
    }

    ctx.session.step = `awaiting_parcel_photo_${parcelId}`;
    delete ctx.session.parcelPhotoCancelledDraft;
    ctx.session.parcelPhotoDraft = {
        parcelId,
        fileIds: [],
        startedAt: Date.now()
    };
    logBusinessEvent({
        event: "logistics.parcel.photo_upload_started",
        actorType: "staff",
        actorRole: "staff",
        telegramId: ctx.from?.id,
        result: "started",
        module: "staff-logistics-handler",
        operation: "parcel_photo_callback",
        safeContext: { parcelId },
    });
    scheduleParcelPhotoReminder(ctx, parcelId);
    await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_prompt, {
        parse_mode: 'HTML',
        reply_markup: buildParcelPhotoDraftKeyboard(parcelId)
    });
    await ctx.answerCallbackQuery();
});

staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "ppd" });
    if (!parcelId) return next();
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

staffLogisticsHandlers.on("callback_query:data", async (ctx, next) => {
    const parcelId = readCallbackPayload(ctx.callbackQuery.data, { code: "ppx" });
    if (!parcelId) return next();
    const draft = ctx.session.parcelPhotoDraft;

    if (!draft || draft.parcelId !== parcelId) {
        await ctx.answerCallbackQuery("Активне завантаження вже завершене.");
        return;
    }

    logBusinessEvent({
        event: "logistics.parcel.photo_upload_cancelled",
        actorType: "staff",
        actorRole: "staff",
        telegramId: ctx.from?.id,
        result: "success",
        module: "staff-logistics-handler",
        operation: "parcel_photo_cancel",
        safeContext: {
            parcelId,
            photoCount: draft.fileIds.length,
        },
    });
    resetParcelPhotoDraft(ctx, { cancelled: true });
    await ctx.answerCallbackQuery("Скасовано.");
    await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_upload_cancelled, buildParcelPhotoRestartKeyboard(parcelId));
});

staffLogisticsHandlers.callbackQuery("parcel_photo_cancel", async (ctx) => {
    const parcelId = getDraftParcelId(ctx);
    if (!parcelId) {
        await ctx.answerCallbackQuery("Активне завантаження вже завершене.");
        return;
    }

    resetParcelPhotoDraft(ctx, { cancelled: true });
    await ctx.answerCallbackQuery("Скасовано.");
    await editOrReplyText(ctx, LOGISTICS_TEXTS_STAFF.photo_upload_cancelled, buildParcelPhotoRestartKeyboard(parcelId));
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
            // Hand off proxy creation to support after saving the number.
            const parcel = await prisma.parcel.findUnique({ where: { id: parcelId } });
            if (parcel) {
                const { logisticsService } = await import("../../../services/logistics-service.js");
                const result = await logisticsService.requestManualProxy(parcelId, {
                    telegramId,
                    requestedPhone: phone,
                });
                await ctx.reply(getManualProxyConfirmationText(Boolean(result?.duplicate)));
            } else {
                await ctx.reply(getManualProxyConfirmationText(false));
            }
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
            logBusinessEvent({
                event: "logistics.parcel.photo_added_to_draft",
                actorType: "staff",
                actorRole: "staff",
                telegramId: ctx.from?.id,
                result: "success",
                module: "staff-logistics-handler",
                operation: "awaiting_parcel_photo_message",
                safeContext: {
                    parcelId,
                    photoCount: currentDraft.fileIds.length,
                },
            });
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

    const recentlyCancelledParcelId = ctx.message?.photo ? getRecentlyCancelledParcelPhotoId(ctx) : null;
    if (recentlyCancelledParcelId) {
        logBusinessEvent({
            event: "logistics.parcel.photo_after_cancel_ignored",
            actorType: "staff",
            actorRole: "staff",
            telegramId: ctx.from?.id,
            result: "ignored",
            module: "staff-logistics-handler",
            operation: "parcel_photo_message_after_cancel",
            safeContext: { parcelId: recentlyCancelledParcelId },
        });
        await ctx.reply(LOGISTICS_TEXTS_STAFF.photo_upload_cancelled_photo_ignored, {
            parse_mode: 'HTML',
            reply_markup: buildParcelPhotoRestartKeyboard(recentlyCancelledParcelId)
        });
        return;
    }

    await next();
});
