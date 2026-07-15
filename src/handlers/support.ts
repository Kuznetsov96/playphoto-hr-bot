import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { CandidateStatus } from "@prisma/client";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { escapeHtml } from "./admin/utils.js";
import { getRichMessagePlainText } from "../utils/rich-message.js";

export const supportHandlers = new Composer<MyContext>();

function clearSupportRouteData(ctx: MyContext) {
    if (!ctx.session.supportData) return;
    delete ctx.session.supportData.preferredTarget;
    delete ctx.session.supportData.entryReason;
}

function getCandidateAge(birthDate?: Date | string | null): number | null {
    if (!birthDate) return null;

    const parsedBirthDate = birthDate instanceof Date ? birthDate : new Date(birthDate);
    if (Number.isNaN(parsedBirthDate.getTime())) return null;

    const today = new Date();
    let age = today.getFullYear() - parsedBirthDate.getFullYear();
    const monthDelta = today.getMonth() - parsedBirthDate.getMonth();

    if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < parsedBirthDate.getDate())) {
        age -= 1;
    }

    return age;
}

function hasBlockedDeliveryReason(candidate: Awaited<ReturnType<typeof candidateRepository.findByTelegramId>>) {
    return candidate?.status === CandidateStatus.BLOCKER || candidate?.candidateDecision?.includes("Бот заблоковано") === true;
}

function isRecoveryEligible(candidate: Awaited<ReturnType<typeof candidateRepository.findByTelegramId>>) {
    const age = getCandidateAge(candidate?.birthDate);
    return candidate?.gender === "female" && age !== null && age >= 17 && age <= 26 && hasBlockedDeliveryReason(candidate);
}

async function ensureRecoveryTopic(ctx: MyContext, candidate: NonNullable<Awaited<ReturnType<typeof candidateRepository.findByTelegramId>>>) {
    const { RECOVERY_CHAT_ID } = await import("../config.js");
    const { supportRepository } = await import("../repositories/support-repository.js");

    const existingTopic = await supportRepository.findActiveOutgoingTopicByUser(candidate.user.id);
    if (existingTopic && Number(existingTopic.chatId) === RECOVERY_CHAT_ID) {
        return existingTopic;
    }

    const surname = (candidate.fullName || "Candidate").trim().split(/\s+/)[0] || "Candidate";
    const locationLabel = candidate.location?.name || candidate.city || "No location";
    const topic = await ctx.api.createForumTopic(RECOVERY_CHAT_ID, `🛟 RECOVERY | ${surname} | ${locationLabel}`);
    const topicId = topic.message_thread_id;
    const topicKeyboard = new InlineKeyboard()
        .text("Reopen to WAITLIST_HR", `recovery_reopen_${candidate.id}_${topicId}`)
        .text("Close Recovery", `close_topic_${topicId}`);

    const usernameLabel = candidate.user.username
        ? `@${escapeHtml(candidate.user.username)}`
        : "not set";

    const infoCard =
        `🛟 <b>Recovery Case</b>\n` +
        `👤 <b>Candidate:</b> ${escapeHtml(candidate.fullName || "Candidate")}\n` +
        `🔗 <b>Username:</b> ${usernameLabel}\n` +
        `📍 <b>Location:</b> ${escapeHtml(locationLabel)}\n` +
        `📊 <b>Current Status:</b> ${escapeHtml(candidate.status)}\n` +
        `📝 <b>Delivery Issue:</b> ${escapeHtml(candidate.candidateDecision || "Bot delivery was previously blocked")}`;

    await ctx.api.sendMessage(RECOVERY_CHAT_ID, infoCard, {
        parse_mode: "HTML",
        message_thread_id: topicId,
        reply_markup: topicKeyboard,
    });

    return supportRepository.createOutgoingTopic({
        chatId: BigInt(RECOVERY_CHAT_ID),
        topicId,
        staffName: candidate.fullName || "Candidate",
        userId: candidate.user.id,
    });
}

// --- CALLBACKS ---
async function startSupportFlow(ctx: MyContext, preferredTarget: "HR" | "MENTOR" | "RECOVERY") {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
    if (user?.staffProfile?.isActive && preferredTarget !== "RECOVERY") {
        const { startSupportFlow: startStaffSupportFlow } = await import("../modules/staff/handlers/menu.js");
        await startStaffSupportFlow(ctx);
        return;
    }

    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) {
        await ctx.answerCallbackQuery("Error: Candidate profile not found.");
        return;
    }

    if (preferredTarget === "RECOVERY") {
        if (!isRecoveryEligible(candidate)) {
            await ctx.answerCallbackQuery("Ця опція недоступна для цього профілю.");
            return;
        }
    } else if (candidate.gender === "male") {
        await ctx.answerCallbackQuery("Ця опція недоступна для цього профілю.");
        return;
    }

    ctx.session.step = "support_chat";
    ctx.session.supportData = {
        ...(ctx.session.supportData || {}),
        preferredTarget,
        ...(preferredTarget === "RECOVERY" ? { entryReason: "RETURNED_AFTER_BOT_BLOCK" as const } : {}),
    };
    await ctx.answerCallbackQuery();
    logBusinessEvent({
        event: "candidate.support.started",
        correlationId: ctx.correlationId,
        updateId: ctx.update.update_id,
        telegramId,
        candidateId: candidate.id,
        actorType: "candidate",
        stage: preferredTarget,
        result: "started",
        module: "support",
        safeContext: { preferredTarget, status: candidate.status }
    });

    const kb = new InlineKeyboard().text("✖️ Скасувати", "end_support_chat").danger();
    await ctx.reply(
        `<b>Напишіть ваше питання або повідомлення нижче ⤵️</b>\n` +
        `Ми одразу передамо його відповідальній особі, і ви отримаєте відповідь прямо тут. ✨`,
        { parse_mode: "HTML", reply_markup: kb }
    );
}

// START SUPPORT FLOW
supportHandlers.callbackQuery("contact_hr", async (ctx) => {
    await startSupportFlow(ctx, "HR");
});

supportHandlers.callbackQuery("contact_mentor", async (ctx) => {
    await startSupportFlow(ctx, "MENTOR");
});

supportHandlers.callbackQuery("contact_recovery", async (ctx) => {
    await startSupportFlow(ctx, "RECOVERY");
});

// END SUPPORT FLOW
supportHandlers.callbackQuery("end_support_chat", async (ctx) => {
    ctx.session.step = "idle";
    clearSupportRouteData(ctx);
    await ctx.editMessageText("Діалог завершено. Якщо захочете написати знову — натисніть кнопку 'Написати нам'. 🌸");
    await ctx.answerCallbackQuery();
});

function getCandidateSupportPayload(ctx: MyContext) {
    const message = ctx.message;
    const richText = getRichMessagePlainText(message?.rich_message);
    const text = message?.text || message?.caption || richText;
    const media =
        message?.photo?.[message.photo.length - 1]?.file_id ||
        message?.video_note?.file_id ||
        message?.voice?.file_id ||
        message?.video?.file_id ||
        null;

    let mediaLabel = "";
    if (message?.photo) mediaLabel = "📷 Photo";
    else if (message?.video_note) mediaLabel = "⭕ Video note";
    else if (message?.voice) mediaLabel = "🎙 Voice message";
    else if (message?.video) mediaLabel = "🎥 Video";

    const richLabel = message?.rich_message ? "Rich message" : "";
    const contentLabel = mediaLabel || richLabel;
    const content = contentLabel && text ? `${contentLabel}: ${text}` : (contentLabel || text);

    return {
        content: content || "Message without text",
        media
    };
}

async function copyCandidateOriginalToAdmin(ctx: MyContext, adminId: string | number, replyMarkup?: InlineKeyboard) {
    const message = ctx.message;
    const hasCopyableContent = Boolean(
        message?.rich_message ||
        message?.photo ||
        message?.video_note ||
        message?.voice ||
        message?.video,
    );
    if (!message?.message_id || !hasCopyableContent) return;

    try {
        await ctx.api.copyMessage(Number(adminId), message.chat.id, message.message_id, {
            reply_markup: replyMarkup
        } as any);
    } catch (e) {
        logger.warn({ err: e, adminId }, "Failed to copy candidate original message to admin");
    }
}

export async function handleSupportMessage(ctx: MyContext): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const step = ctx.session.step || "idle";

    // 1. Explicit support mode
    if (step === "support_chat") {
        // Continue
    } else {
        // 2. Implicit support mode: Check if there's an active ticket or outgoing topic
        try {
            const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
            if (!candidate || !candidate.user) return false;

            // Pre-hire candidates should never be routed to support tickets implicitly
            const isPreHireImplicit = [
                'DISCOVERY_SCHEDULED', 'DISCOVERY_COMPLETED',
                'TRAINING_SCHEDULED', 'TRAINING_COMPLETED',
                'AWAITING_FIRST_SHIFT',
                'NDA', 'KNOWLEDGE_TEST', 'STAGING_SETUP', 'OFFLINE_STAGING',
                'STAGING_ACTIVE', 'READY_FOR_HIRE'
            ].includes(candidate.status);
            if (isPreHireImplicit) return false;

            const { supportRepository } = await import("../repositories/support-repository.js");
            const activeTicket = await supportRepository.findActiveTicketByUser(candidate.user.id);
            const activeOutgoingTopic = !activeTicket ? await supportRepository.findActiveOutgoingTopicByUser(candidate.user.id) : null;

            if (!((activeTicket && activeTicket.topicId) || activeOutgoingTopic)) {
                return false; // No active conversation to route to
            }
        } catch (e) {
            logger.error({ err: e }, "Failed to check active support session in handleSupportMessage");
            return false;
        }
    }

    if (
        !ctx.message?.text &&
        !ctx.message?.rich_message &&
        !ctx.message?.photo &&
        !ctx.message?.voice &&
        !ctx.message?.video &&
        !ctx.message?.video_note
    ) return false;

    try {
        const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
        if (!candidate || !candidate.user) return false;

        const { MENTOR_IDS, HR_IDS, ADMIN_IDS, TEAM_CHATS } = await import("../config.js");
        const { supportService } = await import("../services/support-service.js");
        const { supportRepository } = await import("../repositories/support-repository.js");
        const preferredTarget = ctx.session.supportData?.preferredTarget;
        const entryReason = ctx.session.supportData?.entryReason;
        const isExplicitSupportFlow = step === "support_chat";

        const isMentorStage = [
            'DISCOVERY_SCHEDULED', 'DISCOVERY_COMPLETED',
            'TRAINING_SCHEDULED', 'TRAINING_COMPLETED',
            'AWAITING_FIRST_SHIFT'
        ].includes(candidate.status);
        const isMentorOwnedFlow = step === "support_chat" && preferredTarget === "MENTOR";
        const isRecoveryFlow = step === "support_chat" && preferredTarget === "RECOVERY";

        const isSetupStage = [
            'NDA', 'KNOWLEDGE_TEST', 'STAGING_SETUP', 'OFFLINE_STAGING',
            'STAGING_ACTIVE', 'READY_FOR_HIRE'
        ].includes(candidate.status);

        // All early-funnel statuses → HR DMs
        const isHRStage = [
            'SCREENING', 'WAITLIST', 'WAITLIST_HR', 'WAITLIST_MENTOR', 'MANUAL_REVIEW',
            'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED',
            'DECISION_PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKER'
        ].includes(candidate.status);

        // Setup-stage candidates → always DM main admin directly, skip support tickets
        if (isSetupStage) {
            const payload = getCandidateSupportPayload(ctx);
            const msgText = payload.content;
            logBusinessEvent({
                event: "candidate.support.message_sent",
                correlationId: ctx.correlationId,
                updateId: ctx.update.update_id,
                telegramId,
                candidateId: candidate.id,
                actorType: "candidate",
                stage: "SETUP",
                result: "success",
                module: "support",
                safeContext: { routing: "admin_dm", status: candidate.status }
            });
            const adminMsgText =
                `💬 <b>Message from Candidate (Admin/Setup)</b>\n` +
                `👤 <b>${escapeHtml(candidate.fullName || "Candidate")}</b> (@${escapeHtml(candidate.user.username || "no_user")})\n` +
                `📍 City: ${escapeHtml(candidate.city || "—")}\n` +
                `📊 Status: <b>${escapeHtml(candidate.status)}</b>\n\n` +
                `<b>Text:</b> ${escapeHtml(msgText)}`;

            const adminKb = new InlineKeyboard().text("✍️ Reply", `admin_reply_to_${telegramId}`);

            let delivered = false;
            for (const adminId of ADMIN_IDS) {
                try {
                    await ctx.api.sendMessage(Number(adminId), adminMsgText, {
                        parse_mode: "HTML",
                        reply_markup: adminKb
                    });
                    await copyCandidateOriginalToAdmin(ctx, adminId, adminKb);
                    delivered = true;
                } catch (e) {
                    logger.warn({ err: e, adminId }, "Failed to deliver setup-stage message to admin");
                }
            }

            if (!delivered) {
                await ctx.reply("Вибачте, зараз немає активного адміністратора. Спробуйте пізніше.");
                ctx.session.step = "idle";
                return true;
            }

            try {
                const { messageRepository } = await import("../repositories/message-repository.js");
                const { timelineRepository } = await import("../repositories/timeline-repository.js");
                await messageRepository.create({
                    candidate: { connect: { id: candidate.id } },
                    sender: "USER",
                    scope: "HR",
                    content: msgText,
                    photoId: payload.media
                });
                await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', msgText, { category: "Admin (Setup)" });
                await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
            } catch (e) {
                logger.error({ err: e }, "Failed to log setup-stage message");
            }

            ctx.session.step = "idle";
            clearSupportRouteData(ctx);
            await ctx.reply("✅ Повідомлення надіслано адміністратору! Він відповість найближчим часом. ✨");
            return true;
        }

        // Mentor-owned flow (training/discovery + mentor onboarding) → DM main admin directly.
        // There may be no active mentor during offboarding, but candidates still see the
        // "contact mentor" button in older messages and should get a real reply path.
        // and keep this dialog out of generic support tickets/topics.
        if (isMentorOwnedFlow) {
            const payload = getCandidateSupportPayload(ctx);
            const msgText = payload.content;
            logBusinessEvent({
                event: "candidate.support.message_sent",
                correlationId: ctx.correlationId,
                updateId: ctx.update.update_id,
                telegramId,
                candidateId: candidate.id,
                actorType: "candidate",
                stage: "MENTOR",
                result: "success",
                module: "support",
                safeContext: { routing: "admin_dm", status: candidate.status }
            });
            let categoryLabel = "Admin (Mentor)";
            let targetAdminIds = ADMIN_IDS.length > 0 ? [ADMIN_IDS[0]!] : [];

            if (targetAdminIds.length === 0) {
                await ctx.reply("Вибачте, зараз немає активного адміністратора. Спробуйте пізніше.");
                ctx.session.step = "idle";
                return true;
            }

            const adminMsgText =
                `💬 <b>Message from Candidate (${categoryLabel})</b>\n` +
                `👤 <b>${escapeHtml(candidate.fullName || "Candidate")}</b> (@${escapeHtml(candidate.user.username || "no_user")})\n` +
                `📍 City: ${escapeHtml(candidate.city || "—")}\n` +
                `📊 Status: <b>${escapeHtml(candidate.status)}</b>\n\n` +
                `<b>Text:</b> ${escapeHtml(msgText)}`;

            const adminKb = new InlineKeyboard().text("✍️ Reply", `admin_reply_to_${telegramId}`);

            let delivered = false;
            for (const adminId of targetAdminIds) {
                try {
                    await ctx.api.sendMessage(Number(adminId), adminMsgText, {
                        parse_mode: "HTML",
                        reply_markup: adminKb
                    });
                    await copyCandidateOriginalToAdmin(ctx, adminId, adminKb);
                    delivered = true;
                } catch (e) {
                    logger.warn({ err: e, adminId }, "Failed to deliver mentor-stage message to main admin");
                }
            }

            try {
                const { messageRepository } = await import("../repositories/message-repository.js");
                const { timelineRepository } = await import("../repositories/timeline-repository.js");

                await messageRepository.create({
                    candidate: { connect: { id: candidate.id } },
                    sender: "USER",
                    scope: "MENTOR",
                    content: msgText,
                    photoId: payload.media
                });

                await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', msgText, { category: categoryLabel });
                await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
            } catch (e) {
                logger.error({ err: e }, "Failed to log mentor-stage message");
            }

            ctx.session.step = "idle";
            clearSupportRouteData(ctx);
            await ctx.reply("✅ Повідомлення надіслано адміністратору! Він відповість найближчим часом. ✨");
            return true;
        }

        // Check if there's an active ticket or outgoing topic for the candidate
        const activeTicket = await supportRepository.findActiveTicketByUser(candidate.user.id);
        const activeOutgoingTopic = !activeTicket ? await supportRepository.findActiveOutgoingTopicByUser(candidate.user.id) : null;

        if (isRecoveryFlow) {
            const payload = getCandidateSupportPayload(ctx);
            const topic = activeOutgoingTopic && Number(activeOutgoingTopic.chatId) === TEAM_CHATS.RECOVERY
                ? activeOutgoingTopic
                : await ensureRecoveryTopic(ctx, candidate);

            await ctx.api.copyMessage(Number(topic.chatId), ctx.chat!.id, ctx.message!.message_id, {
                message_thread_id: topic.topicId
            });

            try {
                const { messageRepository } = await import("../repositories/message-repository.js");
                const { timelineRepository } = await import("../repositories/timeline-repository.js");

                await messageRepository.create({
                    candidate: { connect: { id: candidate.id } },
                    sender: "USER",
                    scope: "HR",
                    content: payload.content,
                    photoId: payload.media
                });

                await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', payload.content, {
                    category: "Recovery",
                    entryReason,
                    outgoingTopicId: topic.id,
                });
                await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
            } catch (e) {
                logger.error({ err: e, candidateId: candidate.id }, "Failed to log recovery message");
            }

            logBusinessEvent({
                event: "candidate.support.message_sent",
                correlationId: ctx.correlationId,
                updateId: ctx.update.update_id,
                telegramId,
                candidateId: candidate.id,
                actorType: "candidate",
                stage: "RECOVERY",
                result: "success",
                module: "support",
                safeContext: { routing: "recovery_topic", topicId: topic.topicId, chatId: String(topic.chatId) }
            });

            ctx.session.step = "idle";
            clearSupportRouteData(ctx);
            await ctx.reply("✅ Повідомлення надіслано в recovery-чергу. Ми відповімо тут найближчим часом. ✨");
            return true;
        }

        // If they already have an active TOPIC in Support group, just forward there
        if ((activeTicket && activeTicket.topicId) || activeOutgoingTopic) {
            const topicId = activeTicket?.topicId || activeOutgoingTopic?.topicId;
            const targetChatId = activeTicket ? TEAM_CHATS.SUPPORT : Number(activeOutgoingTopic?.chatId || TEAM_CHATS.SUPPORT);
            try {
                if (ctx.message && topicId) {
                    logBusinessEvent({
                        event: "candidate.support.message_sent",
                        correlationId: ctx.correlationId,
                        updateId: ctx.update.update_id,
                        telegramId,
                        candidateId: candidate.id,
                        actorType: "candidate",
                        stage: isHRStage ? "HR" : "SUPPORT",
                        result: "success",
                        module: "support",
                        safeContext: { routing: activeTicket ? "support_ticket_topic" : "outgoing_topic", ticketId: activeTicket?.id, topicId }
                    });
                    await ctx.api.copyMessage(targetChatId, ctx.chat!.id, ctx.message.message_id, {
                        message_thread_id: topicId
                    });
                    // Touch updatedAt
                    if (activeTicket) await supportRepository.touchTicket(activeTicket.id).catch(() => { });
                    if (activeOutgoingTopic) await supportRepository.touchOutgoingTopic(activeOutgoingTopic.id).catch(() => { });
                    // Log to Timeline
                    const { timelineRepository } = await import("../repositories/timeline-repository.js");
                    await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', getCandidateSupportPayload(ctx).content, {
                        ticketId: activeTicket?.id,
                        outgoingTopicId: activeOutgoingTopic?.id
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "Failed to forward candidate message to topic");
                await ctx.reply("Сталася помилка при відправці повідомлення. Спробуйте пізніше.");
            }
            ctx.session.step = "idle";
            clearSupportRouteData(ctx);
            await ctx.reply("✅ Повідомлення надіслано! Ми відповімо найближчим часом. ✨");
            return true;
        }

        const payload = getCandidateSupportPayload(ctx);
        const msgText = payload.content;

        // --- Route by stage to responsible person ---
        let categoryLabel = "HR";
        let targetAdminIds = HR_IDS;

        if (isSetupStage) {
            categoryLabel = "Admin (Setup)";
            targetAdminIds = ADMIN_IDS;
        } else if (!isExplicitSupportFlow && isMentorStage) {
            categoryLabel = "Admin (Mentor)";
            targetAdminIds = ADMIN_IDS.length > 0 ? [ADMIN_IDS[0]!] : [];
        } else if (isHRStage) {
            categoryLabel = "HR";
            targetAdminIds = HR_IDS;
        }
        // Unknown/future status → also defaults to HR_IDS

        if (targetAdminIds.length === 0) targetAdminIds = ADMIN_IDS;

        if (targetAdminIds.length === 0) {
            await ctx.reply("Вибачте, зараз немає активного адміністратора. Спробуйте пізніше.");
            return true;
        }

        if (isRecoveryFlow) {
            categoryLabel = "Admin (Recovery)";
            targetAdminIds = ADMIN_IDS.length > 0 ? [ADMIN_IDS[0]!] : (HR_IDS.length > 0 ? [HR_IDS[0]!] : []);
        }

        const recoveryBadge = entryReason === "RETURNED_AFTER_BOT_BLOCK"
            ? `🛟 <b>Recovery Case:</b> Returned after bot block\n`
            : "";

        const adminMsgText =
            `💬 <b>Message from Candidate (${categoryLabel})</b>\n` +
            `👤 <b>${escapeHtml(candidate.fullName || "Candidate")}</b> (@${escapeHtml(candidate.user.username || "no_user")})\n` +
            `📍 City: ${escapeHtml(candidate.city || "—")}\n` +
            recoveryBadge +
            `\n` +
            `<b>Text:</b> ${escapeHtml(msgText)}`;

        const adminKb = new InlineKeyboard().text("✍️ Reply", `admin_reply_to_${telegramId}`);

        let delivered = false;
        for (const adminId of targetAdminIds) {
            try {
                await ctx.api.sendMessage(Number(adminId), adminMsgText, {
                    parse_mode: "HTML",
                    reply_markup: adminKb
                });
                await copyCandidateOriginalToAdmin(ctx, adminId, adminKb);
                delivered = true;
            } catch (e) { }
        }

        if (!delivered && ADMIN_IDS.length > 0) {
            await ctx.api.sendMessage(Number(ADMIN_IDS[0]!), adminMsgText, { parse_mode: "HTML", reply_markup: adminKb }).catch(() => { });
        }

        try {
            const { messageRepository } = await import("../repositories/message-repository.js");
            const { timelineRepository } = await import("../repositories/timeline-repository.js");

            await messageRepository.create({
                candidate: { connect: { id: candidate.id } },
                sender: "USER",
                scope: categoryLabel === "Mentor" ? "MENTOR" : "HR",
                content: msgText,
                photoId: payload.media
            });

            await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', msgText, {
                category: categoryLabel,
                entryReason,
            });
            await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
        } catch (e) { }

        ctx.session.step = "idle";
        clearSupportRouteData(ctx);
        await ctx.reply("✅ Повідомлення надіслано! Ми відповімо найближчим часом. ✨");

        return true;

    } catch (e) {
        logger.error({ err: e }, "Error in handleSupportMessage");
        return false;
    }
}
