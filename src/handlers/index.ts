import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { buildAnsweredOfferText } from "../services/replacement-offer-answered-text.js";
import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { hrHandlers } from "./hr.js";
import { adminMenu, adminHandlers } from "./admin/index.js";
import { mentorHandlers } from "./mentor.js";
import { commandHandlers } from "./commands.js";
import { bookingHandlers } from "./booking.js";
import { staffModule } from "../modules/staff/index.js";
import { candidateModule } from "../modules/candidate/index.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";
import { staffSupportHandlers, handleSupportGroupMessage } from "../modules/staff/handlers/support.js";
import { supportHandlers, handleSupportMessage } from "./support.js";
import { firstShiftOnboardingHandlers, handleFirstShiftOnboardingCandidateMessage, handleFirstShiftOnboardingGroupMessage } from "./first-shift-onboarding.js";
import { staffLogisticsHandlers } from "../modules/staff/handlers/logistics.js";
import { preferencesHandlers } from "./preferences-flow.js";
import { bot } from "../core/bot.js";
import { shouldRouteMessageToPrivateRoleFlows } from "../utils/message-routing.js";
import { quizHandlers } from "./quiz-handler.js";
import { onboardingHandlers } from "./onboarding-handler.js";
import { accessHandlers } from "./access.js";
import { broadcastService } from "../services/broadcast.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { extractFirstName } from "../utils/string-utils.js";
import { slotBuilderHandlers } from "./slot-builder.js";
import { leadsHandlers } from "./leads.js";
import { blockShield } from "../middleware/block-shield.js";
import { buildSignedCallback, readCallbackPayload } from "../utils/signed-callback.js";
import { ScreenManager } from "../utils/screen-manager.js";
import { canConfirmNDA } from "../utils/final-step-flow.js";
import { escapeHtml } from "./admin/utils.js";
import { logBusinessEvent } from "../core/log-events.js";
import prisma from "../db/core.js";
import { awsBusinessClient } from "../services/aws-business-client.js";
import {
    answerReplacementOffer,
    REPLACEMENT_OFFER_ACCEPT_CALLBACK_CODE,
    REPLACEMENT_OFFER_DECLINE_CALLBACK_CODE,
    REPLACEMENT_REVERT_CALLBACK_CODE,
    REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE,
    revertReplacementIfOwner,
    undoReplacementAcceptanceAsCandidate
} from "../services/replacement-notification-dispatcher.js";
import { REPLACEMENT_UNDO_CALLBACK_CODE } from "../services/schedule-notification-dispatcher.js";

export const handlers = new Composer<MyContext>();

// 1. GLOBAL SHIELDS (Highest Priority)
handlers.use(blockShield);

handlers.use(async (ctx, next) => {
    // logger.info(`🔍 [DEBUG] Handlers Entry: ${ctx.update.update_id}`);
    await next();
});

// Preferences flow must be global (accessible to staff via PM and admins via stats)
handlers.use(preferencesHandlers);

// 0. Menus should be handled at root level now

// Staff Shield: Intercept old/invalid callbacks from active staff
handlers.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // If it's a known new callback or menu callback, let it pass
    if (data.startsWith("cb:") ||
        data.startsWith("staff_") || data.startsWith("staff-") || data.startsWith("admin_") || data.startsWith("admin-") ||
        data.startsWith("hr_") || data.startsWith("hr-") ||
        data.startsWith("mentor_") || data.startsWith("mentor-") ||
        data.startsWith("fso_") ||
        data.startsWith("tas_") || data.startsWith("task_") || data.startsWith("b_") || data.startsWith("ticket_") ||
        data.startsWith("broadcast_") || data.startsWith("pref_") || data.startsWith("onb_") ||
        data.startsWith("gender_") || data.startsWith("city_") || data.startsWith("loc_") || data.startsWith("src_") ||
        data.startsWith("close_topic_") || data.startsWith("close_ticket_") || data.startsWith("contact_hr") || data.startsWith("contact_mentor") || data.startsWith("contact_recovery") || data.startsWith("recovery_reopen_") ||
        data.startsWith("end_support_chat") || data.startsWith("view_staff_") ||
        data.startsWith("view_candidate_") || data.startsWith("approve_") || data.startsWith("reject_") ||
        data.startsWith("parcel_") ||
        data.startsWith("confirm_") || data.startsWith("cancel_") || data.startsWith("staging_") ||
        data.includes("/")) {
        return next();
    }

    // Check if user is active staff (but NOT admin — admins have their own handlers)
    const telegramId = ctx.from?.id;
    if (telegramId) {
        const { getAdminRoleByTelegramId } = await import("../config/roles.js");
        if (getAdminRoleByTelegramId(BigInt(telegramId))) {
            // Admin user — don't intercept, let admin handlers process
            return next();
        }

        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
        if (user?.staffProfile?.isActive) {
            logger.debug({ telegramId, data }, "Staff shield intercepted stale callback");
            await ctx.answerCallbackQuery("⚠️ This button is outdated. Updating menu... ✨");

            // Apple Style: Auto-cleanup of stale context
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Ignore if already deleted
            }

            const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
            await showStaffHub(ctx, true); // forceNew = true to ensure a fresh clean menu
            return;
        }

        // Fired staff (staffProfile exists but isActive=false): silently discard stale callbacks
        if (user?.staffProfile && !user.staffProfile.isActive) {
            logger.debug({ telegramId, data }, "Staff shield discarded callback for inactive staff");
            await ctx.answerCallbackQuery("Твій акаунт деактивовано. Зверніться до адміністратора. 🌸").catch(() => { });
            return;
        }
    }

    await next();
});

// Leads Handler (Topics Management)
handlers.use(leadsHandlers);

// 1. Core System Handlers (High Priority: Support, HR, Admin, Mentor, Commands)
handlers.use(commandHandlers);
handlers.use(quizHandlers);
// onboardingHandlers moved to guest context for better support routing priority
handlers.use(accessHandlers); // ✅ NEW: Handle join requests & membership sync

// Handle NDA resend from Status Card
handlers.on("callback_query:data", async (ctx, next) => {
    const candId = readCallbackPayload(ctx.callbackQuery.data, { code: "snda" });
    if (!candId) return next();
    await ctx.answerCallbackQuery("Відправляю NDA... 📋");

    const { candidateRepository } = await import("../repositories/candidate-repository.js");
    const cand = await candidateRepository.findById(candId);
    if (!cand) return;
    if (Number(cand.user.telegramId) !== ctx.from?.id) {
        await ctx.answerCallbackQuery("Ця дія недоступна.");
        return;
    }

    const firstName = escapeHtml(extractFirstName(cand.fullName || ""));
    const { NDA_LINK } = await import("../config.js");
    const { InlineKeyboard } = await import("grammy");

    // Update ndaSentAt to reset reminder timer if they re-request
    await candidateRepository.update(candId, { ndaSentAt: new Date() });

    await ctx.reply(
        `Ось твоє посилання на <b>Договір про нерозголошення (NDA)</b>, ${firstName}: 📋\n\n` +
        `🔗 <a href="${NDA_LINK}">Договір NDA PlayPhoto</a>\n\n` +
        `Прочитай його уважно і натисни кнопку нижче, коли будеш готова продовжувати! ✨`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("✅ Ознайомлена з NDA", buildSignedCallback("cnda", cand.id))
        }
    );
});

// Handle NDA confirmation
handlers.on("callback_query:data", async (ctx, next) => {
    const candId = readCallbackPayload(ctx.callbackQuery.data, { code: "cnda" });
    if (!candId) return next();
    const { candidateRepository } = await import("../repositories/candidate-repository.js");
    const { CandidateStatus } = await import("@prisma/client");
    const cand = await candidateRepository.findById(candId);
    if (!cand || Number(cand.user.telegramId) !== ctx.from?.id) {
        await ctx.answerCallbackQuery("Ця дія недоступна.");
        return;
    }
    if (!canConfirmNDA(cand)) {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
        await ctx.answerCallbackQuery("Цей крок уже пройдено ✨");
        return;
    }
    await candidateRepository.update(candId, {
        ndaConfirmedAt: new Date(),
        status: CandidateStatus.READY_FOR_HIRE
    });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery("Дякуємо! NDA підтверджено. ✅");
    await ScreenManager.renderScreen(
        ctx,
        CANDIDATE_TEXTS["nda-confirmed-start-onboarding"],
        new InlineKeyboard().text("📝 Почати оформлення", "start_onboarding_data")
    );
});

// Schedule change notification acknowledgement.
// This records that the photographer saw the change and how they answered. It
// never cancels or reassigns a shift: the backend owns the schedule, and a
// refusal surfaces to the owner rather than acting on its own.
handlers.callbackQuery(/^cb:(snack|sndec):/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const confirmed = data.startsWith("cb:snack:");
    const notificationPublicId = readCallbackPayload(data, { code: confirmed ? "snack" : "sndec" });
    if (!notificationPublicId) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
    }

    const telegramId = ctx.from?.id;
    const staff = telegramId
        ? await prisma.staffProfile.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
            select: { awsEmployeePublicId: true }
        })
        : null;

    // Without a canonical employee id the backend cannot verify who is answering,
    // so there is nothing safe to record. Say so rather than implying it landed.
    if (!staff?.awsEmployeePublicId) {
        logBusinessEvent({
            event: "bot.schedule_notifications.acknowledge_failed",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "EMPLOYEE_NOT_MAPPED",
            module: "schedule-notification-dispatcher",
            operation: "acknowledge",
            safeContext: { notificationPublicId },
        });
        return ctx.answerCallbackQuery({
            text: STAFF_TEXTS["schedule-notif-ans-unavailable-alert"],
            show_alert: true,
        });
    }

    try {
        await awsBusinessClient.acknowledgeScheduleNotification(
            notificationPublicId,
            staff.awsEmployeePublicId,
            confirmed ? "ACCEPTED" : "REFUSED"
        );
    } catch (error) {
        logBusinessEvent({
            event: "bot.schedule_notifications.acknowledge_failed",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "ACKNOWLEDGE_REQUEST_FAILED",
            module: "schedule-notification-dispatcher",
            operation: "acknowledge",
            safeContext: {
                notificationPublicId,
                errorType: error instanceof Error ? error.constructor.name : "UnknownError"
            },
        });
        // The buttons stay in place so the photographer can try again.
        return ctx.answerCallbackQuery({
            text: STAFF_TEXTS["schedule-notif-ans-unavailable-alert"],
            show_alert: true,
        });
    }

    logBusinessEvent({
        event: "bot.schedule_notifications.acknowledged",
        telegramId,
        actorType: "staff",
        actorRole: "staff",
        result: "success",
        reasonCode: confirmed ? "ACKNOWLEDGED_CONFIRMED" : "ACKNOWLEDGED_DECLINED",
        module: "schedule-notification-dispatcher",
        operation: "acknowledge",
        safeContext: { notificationPublicId },
    });

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery(
        confirmed
            ? STAFF_TEXTS["schedule-notif-ans-confirmed"]
            : STAFF_TEXTS["schedule-notif-ans-declined"]
    );
});

// Owner's revert button on an ACCEPTED_OWNER_REVIEW replacement message.
//
// The backend cannot verify who pressed this: its service token proves only
// "this is the bot", and there is no telegramId on the owner (User) model to
// check against. `revertReplacementIfOwner` is the ONLY gate — it must run,
// and must run before any API call, every single time. See its doc comment
// in `services/replacement-notification-dispatcher.js` for the full reasoning.
//
// A shift starting within two hours makes the backend answer
// REPLACEMENT_REVERT_NEEDS_ACKNOWLEDGEMENT instead of reverting outright: the
// owner is warned that a replacement may not be found in time and must tap a
// second, distinct button (`replrvc`) to proceed. Both taps run through this
// same gate — the second tap is not a shortcut around it.
handlers.callbackQuery(new RegExp(`^cb:${REPLACEMENT_REVERT_CALLBACK_CODE}:`), async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const requestPublicId = readCallbackPayload(data, { code: REPLACEMENT_REVERT_CALLBACK_CODE });
    if (!requestPublicId) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
    }

    await performOwnerRevert(ctx, requestPublicId, false);
});

// Second tap: the owner already saw the late-revert warning and confirmed.
handlers.callbackQuery(new RegExp(`^cb:${REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE}:`), async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const requestPublicId = readCallbackPayload(data, { code: REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE });
    if (!requestPublicId) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
    }

    await performOwnerRevert(ctx, requestPublicId, true);
});

async function performOwnerRevert(
    ctx: MyContext,
    requestPublicId: string,
    acknowledgeLateRevert: boolean
): Promise<void> {
    const outcome = await revertReplacementIfOwner({
        telegramId: ctx.from?.id,
        requestPublicId,
        acknowledgeLateRevert,
        client: awsBusinessClient,
    });

    if (outcome === "denied") {
        await ctx.answerCallbackQuery(STAFF_TEXTS["admin-err-access-denied"]);
        return;
    }
    if (outcome === "needs_acknowledgement") {
        // Replace the original revert button with a warning and an explicit
        // second confirmation — the owner is told *why* it didn't just work,
        // not left thinking the tap failed.
        await ctx
            .editMessageReplyMarkup({
                reply_markup: new InlineKeyboard()
                    .text(
                        STAFF_TEXTS["staff-replacement-revert-late-btn-confirm"],
                        buildSignedCallback(REPLACEMENT_REVERT_CONFIRM_CALLBACK_CODE, requestPublicId)
                    )
                    .row()
                    .text(STAFF_TEXTS["staff-replacement-revert-late-btn-cancel"], "staff_hub_nav")
            })
            .catch(() => { });
        await ctx.answerCallbackQuery({
            text: STAFF_TEXTS["staff-replacement-revert-late-warning"],
            show_alert: true
        });
        return;
    }
    if (outcome === "failed") {
        await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-revert-ans-failed"]);
        return;
    }

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-revert-ans-done"]);
}

// The accepting photographer's own undo button, attached to her
// SHIFT_REASSIGNED confirmation message (see buildDeliveryKeyboard in
// schedule-notification-dispatcher.js — the replacement dispatcher only ever
// messages the owner, never the candidate, so this button has to live on the
// pre-existing schedule-change message instead of a replacement-specific one).
//
// Unlike the owner revert button, the backend CAN verify who is pressing
// this: the offer is looked up by (offerPublicId, employeePublicId,
// telegramId) and undoByCandidate re-checks ownership itself, so the window
// and ownership checks are deliberately not duplicated here — same division
// of responsibility as accept/decline.
handlers.callbackQuery(new RegExp(`^cb:${REPLACEMENT_UNDO_CALLBACK_CODE}:`), async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const offerPublicId = readCallbackPayload(data, { code: REPLACEMENT_UNDO_CALLBACK_CODE });
    if (!offerPublicId) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
    }

    const telegramId = ctx.from?.id;
    const staff = telegramId
        ? await prisma.staffProfile.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
            select: { awsEmployeePublicId: true }
        })
        : null;
    if (!staff?.awsEmployeePublicId || telegramId === undefined) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-ans-failed"]);
    }

    const outcome = await undoReplacementAcceptanceAsCandidate({
        offerPublicId,
        employeePublicId: staff.awsEmployeePublicId,
        telegramId,
        client: awsBusinessClient,
    });

    if (outcome === "window_closed") {
        return ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-ans-window-closed"]);
    }
    if (outcome === "failed") {
        return ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-ans-failed"]);
    }

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    await ctx.answerCallbackQuery(STAFF_TEXTS["staff-replacement-undo-done"]);
});

// A candidate answering a canonical OFFER. Both buttons route here; the code
// they were signed with is the only thing that distinguishes yes from no.
//
// The backend owns the outcome: it re-verifies that the offer belongs to this
// employee and is still open, so neither check is repeated here — the same
// division of responsibility as the undo button above. The keyboard is cleared
// on every terminal answer, including "gone", so a message that can no longer
// be acted on never keeps a live-looking button.
async function handleOfferAnswer(ctx: MyContext, answer: "accept" | "decline") {
    const data = ctx.callbackQuery?.data ?? "";
    const code =
        answer === "accept"
            ? REPLACEMENT_OFFER_ACCEPT_CALLBACK_CODE
            : REPLACEMENT_OFFER_DECLINE_CALLBACK_CODE;
    const offerPublicId = readCallbackPayload(data, { code });
    if (!offerPublicId) {
        return ctx.answerCallbackQuery(STAFF_TEXTS["schedule-notif-ans-expired"]);
    }

    const telegramId = ctx.from?.id;
    const staff = telegramId
        ? await prisma.staffProfile.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
            select: { awsEmployeePublicId: true }
        })
        : null;
    if (!staff?.awsEmployeePublicId || telegramId === undefined) {
        // Тот же случай, что и у подтверждения графика выше: без канонического id
        // ответ отправить некуда. Молчать нельзя — снаружи это выглядит как
        // сломанная кнопка, а причина видна только в данных.
        logBusinessEvent({
            event: "bot.replacement_notifications.answer_failed",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "EMPLOYEE_NOT_MAPPED",
            module: "replacement-notification-dispatcher",
            operation: "answerReplacementOffer",
            safeContext: { offerPublicId, answer },
        });
        return ctx.answerCallbackQuery({
            text: STAFF_TEXTS["staff-replacement-offer-error-alert"],
            show_alert: true,
        });
    }

    const outcome = await answerReplacementOffer({
        offerPublicId,
        employeePublicId: staff.awsEmployeePublicId,
        telegramId,
        answer,
        client: awsBusinessClient,
    });

    // show_alert: узкая всплывашка обрезает текст примерно на 45 символах, и
    // фотограф видела «...Спробуй ще раз за хви...» — то есть ровно ту часть, где
    // сказано, что делать, до неё и не доходило. Ошибка — единственный случай,
    // когда ей нужно что-то предпринять, поэтому она показывается плашкой с
    // кнопкой «ОК», а успешные ответы остаются ненавязчивым тостом.
    if (outcome === "failed") {
        return ctx.answerCallbackQuery({
            text: STAFF_TEXTS["staff-replacement-offer-error-alert"],
            show_alert: true,
        });
    }

    // Сообщение переписывается на месте: исход должен читаться там же, где
    // названа смена. Отдельное сообщение оторвало бы «Зміна твоя» от того, о чём
    // оно, а при девятнадцяти оферах на один пошук ще й засмітило б стрічку.
    //
    // Детали берутся из текста самого сообщения, а не из ответа бэкенда: тот
    // отдаёт время в UTC, и зміна на 14:00 за Києвом показалась б як 11:00.
    const originalText = ctx.callbackQuery?.message?.text ?? "";
    const rewritten = buildAnsweredOfferText(originalText, outcome);
    const edited = await ctx
        .editMessageText(rewritten, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } })
        .then(() => true)
        .catch(() => false);
    if (!edited) {
        // Telegram отказывает по своим причинам — сообщение старше 48 часов, гонка
        // двух нажатий. Тогда хотя бы снимаем кнопки, чтобы мёртвая не выглядела
        // живой; бэкенд всё равно поглотит повторное нажатие.
        //
        // Ответ фотографе при этом уже сохранён, так что это не сбой операции, а
        // расхождение того, что она видит, с тем, что записано. Пишется warn, а не
        // error: если такие строки пойдут потоком, значит правка перестала
        // проходить и карточки остаются с живыми на вид кнопками.
        logBusinessEvent({
            event: "bot.replacement_notifications.answer_message_not_rewritten",
            level: "warn",
            telegramId,
            actorType: "staff",
            actorRole: "staff",
            result: "failure",
            reasonCode: "MESSAGE_EDIT_REJECTED",
            module: "replacement-notification-dispatcher",
            operation: "answerReplacementOffer",
            safeContext: { offerPublicId, answer, outcome },
        });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => { });
    }

    const answered =
        outcome === "accepted"
            ? STAFF_TEXTS["staff-replacement-offer-accepted"]
            : outcome === "declined"
              ? STAFF_TEXTS["staff-replacement-offer-declined"]
              : STAFF_TEXTS["staff-replacement-offer-gone"];
    await ctx.answerCallbackQuery(answered);
}

handlers.callbackQuery(new RegExp(`^cb:${REPLACEMENT_OFFER_ACCEPT_CALLBACK_CODE}:`), (ctx) =>
    handleOfferAnswer(ctx, "accept"),
);

handlers.callbackQuery(new RegExp(`^cb:${REPLACEMENT_OFFER_DECLINE_CALLBACK_CODE}:`), (ctx) =>
    handleOfferAnswer(ctx, "decline"),
);

// Global Broadcast Receipt Confirmation
handlers.callbackQuery(/^broadcast_confirm_ok_(.+)$/, async (ctx) => {
    const broadcastId = parseInt(ctx.match![1]!);
    if (isNaN(broadcastId)) return ctx.answerCallbackQuery("Invalid ID");
    const result = await broadcastService.confirmRead(ctx, broadcastId);

    if (result !== "confirmed") {
        return;
    }

    if (ctx.chat?.type !== "private") {
        return;
    }

    try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply(STAFF_TEXTS["broadcast-ans-success"]);
    } catch (e) { }
});

handlers.callbackQuery(/^broadcast_confirm_decline_(.+)$/, async (ctx) => {
    const broadcastId = parseInt(ctx.match![1]!);
    if (isNaN(broadcastId)) return ctx.answerCallbackQuery("Invalid ID");

    const result = await broadcastService.confirmDecline(ctx, broadcastId);

    if (result !== "declined") {
        return;
    }

    // Set session step to wait for reason
    ctx.session.step = "broadcast_decline_reason";
    ctx.session.broadcastId = broadcastId;

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply(STAFF_TEXTS["broadcast-ask-decline-reason"], {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: STAFF_TEXTS["hr-btn-cancel"], callback_data: "staff_hub_nav" }]]
        }
    });
});

// Reordered: Support handlers first to avoid Admin/HR Menu interference (greedy matches)
handlers.use(supportHandlers);
handlers.use(firstShiftOnboardingHandlers);
handlers.use(staffSupportHandlers); // ✅ NEW: Allow Admins to use ticket buttons (ticket_assign, etc.)

// Replaced global registration with conditional one in routing below
// handlers.use(hrHandlers);
// handlers.use(adminHandlers); 
// handlers.use(mentorHandlers);
// handlers.use(testingHandlers);

// 2. Global Group Message Handler (Admin answering in Support Chat)
handlers.on("message", async (ctx, next) => {
    // 0. Preferences comment capture
    const { handlePreferenceComment } = await import("./preferences-flow.js");
    if (await handlePreferenceComment(ctx)) return;

    // Check if it's an Admin message in Support Group
    const firstShiftHandled = await handleFirstShiftOnboardingGroupMessage(ctx);
    if (firstShiftHandled) return;

    // Check if it's an Admin message in Support Group
    // A. For Staff (Returns true if handled)
    const staffHandled = await handleSupportGroupMessage(ctx, bot);
    if (staffHandled) return;

    // All supported group-message flows are handled above. Stop other group and
    // service messages (including community_chat_added/removed) before they can
    // enter private candidate/staff role routing.
    if (!shouldRouteMessageToPrivateRoleFlows(ctx.chat?.type)) return;

    await next();
});

handlers.callbackQuery("staff_hub_nav", async (ctx) => {
    const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
    await showStaffHub(ctx);
    await ctx.answerCallbackQuery();
});

const adminApp = new Composer<MyContext>();
adminApp.use(slotBuilderHandlers);
adminApp.use(hrHandlers);
adminApp.use(adminHandlers);
adminApp.use(mentorHandlers);
const adminMiddleware = adminApp.middleware();

const staffApp = new Composer<MyContext>();
staffApp.use(mentorHandlers);
staffApp.use(staffLogisticsHandlers);
staffApp.use(staffModule);
const staffMiddleware = staffApp.middleware();

const guestApp = new Composer<MyContext>();
guestApp.on("message", async (ctx, next) => {
    const firstShiftHandled = await handleFirstShiftOnboardingCandidateMessage(ctx);
    if (firstShiftHandled) return;

    const handled = await handleSupportMessage(ctx);
    if (handled) return;
    await next();
});
guestApp.use(onboardingHandlers);
guestApp.use(bookingHandlers);
guestApp.use(candidateModule);
const guestMiddleware = guestApp.middleware();

// 3. Role-Based Routing (Staff vs Candidate)
handlers.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return next();

    // Admin users should NOT be routed to staffModule — admin handlers above already handle them.
    // Only route non-admin staff to staffModule.
    const { getUserAdminRole } = await import("../middleware/role-check.js");
    const adminRole = await getUserAdminRole(BigInt(telegramId));

    if (adminRole) {
        await adminMiddleware(ctx, next);
        return;
    }

    // Check if user is staff
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));

    if (user?.staffProfile) {
        if (ctx.chat?.type === "private" && ctx.message) {
            const supportSteps = ["support_chat", "create_ticket", "broadcast_decline_reason", "reply_and_close"];
            if (!supportSteps.includes(ctx.session.step || "")) {
                const firstShiftHandled = await handleFirstShiftOnboardingCandidateMessage(ctx);
                if (firstShiftHandled) return;
            }
        }

        // Shield: Block deactivated staff from accessing any staff features
        if (!user.staffProfile.isActive) {
            if (ctx.chat?.type === "private") {
                const text = STAFF_TEXTS["staff-deactivated-shield"];
                if (ctx.callbackQuery) {
                    await ctx.answerCallbackQuery({ text: "Access Revoked", show_alert: true });
                } else {
                    await ctx.reply(text, { parse_mode: "HTML" });
                }
            }
            return; // Block further processing for this user
        }

        await staffMiddleware(ctx, next);
    } else {
        await guestMiddleware(ctx, next);
    }
});
