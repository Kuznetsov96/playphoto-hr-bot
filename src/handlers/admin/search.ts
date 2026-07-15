import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { STAFF_TEXTS } from "../../constants/staff-texts.js";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { SUPPORT_CHAT_ID, ADMIN_IDS } from "../../config.js";
import { userRepository } from "../../repositories/user-repository.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { supportRepository } from "../../repositories/support-repository.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { staffService } from "../../modules/staff/services/index.js";
import { escapeHtml, formatLocationName, getAdminOutboundText, sendAdminOutboundMessage } from "./utils.js";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";

export const adminSearchHandlers = new Composer<MyContext>();

const DIRECT_CANDIDATE_MESSAGE_STATUSES = new Set([
    "DISCOVERY_SCHEDULED",
    "DISCOVERY_COMPLETED",
    "TRAINING_SCHEDULED",
    "TRAINING_COMPLETED",
    "NDA",
    "KNOWLEDGE_TEST",
    "READY_FOR_HIRE",
    "STAGING_SETUP",
    "STAGING_ACTIVE",
    "OFFLINE_STAGING",
    "AWAITING_FIRST_SHIFT"
]);

function shouldUseDirectCandidateMessage(candidate: { status?: string } | null | undefined) {
    return !!candidate?.status && DIRECT_CANDIDATE_MESSAGE_STATUSES.has(candidate.status);
}

function getCandidateBackCallback(ctx: MyContext, candidateId: string) {
    const profileMenuId = ctx.session.candidateProfileMenuId;
    if (profileMenuId === "hr-candidate-unified" && ctx.session.candidateData?.id === candidateId) {
        return `hr_back_candidate_${candidateId}`;
    }
    return `view_candidate_${candidateId}`;
}

function startSearchFlow(ctx: MyContext) {
    ctx.session.adminFlow = 'SEARCH';
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
}

export async function startAdminMessageFlow(ctx: MyContext, userId: string) {
    // MUST answer the callback query first to prevent Telegram loading spinner
    await ctx.answerCallbackQuery().catch(() => { });

    startSearchFlow(ctx);

    const user = await userRepository.findById(userId);
    if (!user) {
        return ScreenManager.renderScreen(ctx, "⚠️ Дані користувача відсутні в базі. Зверніться до адміна.", new InlineKeyboard().text("← Back", "admin_main_back"));
    }

    const candidate = await candidateRepository.findByUserId(userId);
    const staff = await staffRepository.findByUserId(userId);

    const displayName = staff
        ? staffService.formatStaffName(staff.fullName)
        : (candidate?.fullName || user.username || `User ${user.telegramId}`);

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasPermission } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    const canCreateTopic = !shouldUseDirectCandidateMessage(candidate)
        && (hasPermission(role, 'SUPPORT_CHAT') || hasPermission(role, 'MENTOR_ONBOARDING'));

    ctx.session.step = `admin_msg_${userId}`;

    const text = `Write message for <b>${displayName}</b>: ✉️\n\n` +
        (canCreateTopic
            ? `<i>A support ticket and topic will be created automatically after sending.</i>`
            : `<i>Message will be delivered directly to the user.</i>`);

    await ScreenManager.renderScreen(
        ctx,
        text,
        new InlineKeyboard().text(ADMIN_TEXTS["btn-cancel"], "admin_main_back").danger(),
        { pushToStack: true }
    );
}

export async function startAdminSearch(ctx: MyContext) {
    startSearchFlow(ctx);
    ctx.session.step = "admin_search_cand";
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-cand-prompt"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step").danger(), { pushToStack: true });
}

export async function startAdminStaffSearch(ctx: MyContext) {
    startSearchFlow(ctx);
    ctx.session.step = "admin_search_staff";
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-staff-prompt"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step").danger(), { pushToStack: true });
}

adminSearchHandlers.callbackQuery(/^admin_reply_to_(.+)$/, async (ctx) => {
    const telegramId = ctx.match![1]!;
    await ctx.answerCallbackQuery().catch(() => { });

    startSearchFlow(ctx);
    ctx.session.step = `admin_reply_direct_${telegramId}`;
    await ScreenManager.renderScreen(ctx, `Write response for candidate (ID: ${telegramId}): ✍️\n\n<i>Message will be delivered directly to her bot chat.</i>`, new InlineKeyboard().text(ADMIN_TEXTS["btn-cancel"], "cancel_step").danger(), { pushToStack: true });
});

adminSearchHandlers.callbackQuery(/^forward_to_kuznetsov_(.+)$/, async (ctx) => {
    const topicId = Number(ctx.match![1]!);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-topic-ans-fwd-ok"]).catch(() => { });

    const kuznetsovId = ADMIN_IDS[0];
    if (!kuznetsovId) {
        logger.error("Admin topic forward target is not configured");
        return;
    }

    if (ctx.callbackQuery.message) {
        try {
            const forwarded = await ctx.api.copyMessage(kuznetsovId, SUPPORT_CHAT_ID, ctx.callbackQuery.message.message_id);

            // Add "Go to topic" button for Kuznetsov
            const chatIdStr = String(SUPPORT_CHAT_ID);
            const cleanChatId = chatIdStr.startsWith('-100')
                ? chatIdStr.substring(4)
                : chatIdStr.replace('-', '');

            const topicUrl = `https://t.me/c/${cleanChatId}/${topicId}`;
            const keyboard = new InlineKeyboard().url(STAFF_TEXTS["support-btn-go-to-topic"], topicUrl);

            await ctx.api.editMessageReplyMarkup(kuznetsovId, forwarded.message_id, { reply_markup: keyboard });
        } catch (e: any) {
            logger.error({ err: e, topicId, targetTelegramId: kuznetsovId }, "Admin topic forward failed");
        }
    }
});

adminSearchHandlers.on(["message:text", "message:photo", "message:video", "message:document"], async (ctx, next) => {
    const step = ctx.session.step || "";
    const isDirectReplyStep = step.startsWith("admin_reply_direct_");
    const isDirectMessageStep = step.startsWith("admin_msg_");
    const isSearchStep = step === "admin_search_cand" || step === "admin_search_staff";

    if ((isDirectReplyStep || isDirectMessageStep || isSearchStep) && ctx.session.adminFlow !== "SEARCH") {
        return next();
    }

    if (isSearchStep) {
        await ctx.deleteMessage().catch(() => { });
    }

    if (isDirectReplyStep) {
        const targetTgId = step.replace("admin_reply_direct_", "");
        const messageText = getAdminOutboundText(ctx.message) || "[Media Message]";

        try {
            const user = await userRepository.findByTelegramId(BigInt(targetTgId));
            if (!user) throw new Error("User not found in DB");

            // 1. Check if candidate to conditionally show reply button
            const candidate = await candidateRepository.findByUserId(user.id);

            // 2. Deliver to User — reply button only for candidates
            let outboundReplyMarkup: InlineKeyboard | undefined;
            if (candidate && candidate.gender !== "male") {
                outboundReplyMarkup = new InlineKeyboard().text("💬 Відповісти", "contact_hr");
            }
            await sendAdminOutboundMessage(
                ctx,
                Number(targetTgId),
                outboundReplyMarkup ? { replyMarkup: outboundReplyMarkup } : undefined
            );
            await ctx.deleteMessage().catch(() => { });

            // 3. Log to Timeline
            const { timelineRepository } = await import("../../repositories/timeline-repository.js");
            await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', messageText, {
                adminId: ctx.from?.id,
                adminName: ctx.from?.first_name,
                directReply: true
            });

            // 4. Mark unread as handled if candidate
            if (candidate) {
                await candidateRepository.update(candidate.id, { hasUnreadMessage: false });
            }

            const kb = new InlineKeyboard();
            if (candidate) kb.text("👤 Back to Profile", getCandidateBackCallback(ctx, candidate.id)).row();
            else {
                const staff = await staffRepository.findByUserId(user.id);
                if (staff) kb.text("👤 Back to Profile", `view_staff_${staff.id}`).row();
            }
            kb.text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");

            await ScreenManager.renderScreen(ctx, "✅ Response sent successfully!", kb);
            ctx.session.step = "idle";
            if (ctx.session.adminFlow === "SEARCH") {
                delete ctx.session.adminFlow;
            }
        } catch (e: any) {
            logger.error({ err: e, targetTelegramId: targetTgId }, "Admin direct reply delivery failed");
            await ScreenManager.renderScreen(ctx, `❌ Failed to send: ${e.message}`);
        }
        return;
    }

    if (isDirectMessageStep) {
        const userId = step.replace("admin_msg_", "");
        ctx.session.step = "idle";
        if (ctx.session.adminFlow === "SEARCH") {
            delete ctx.session.adminFlow;
        }
        await handleAdminMessageSend(ctx, userId);
        return;
    }

    if (step === "admin_search_cand") {
        if (!ctx.message.text) {
            await ScreenManager.renderScreen(ctx, "Enter text to search for a candidate.", new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-home"], "admin_main_back"));
            return;
        }
        const query = ctx.message.text.trim();
        ctx.session.step = "idle";
        if (ctx.session.adminFlow === "SEARCH") {
            delete ctx.session.adminFlow;
        }

        const candidates = await candidateRepository.findByQuery(query);
        if (candidates.length === 0) {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-no-results"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-home"], "admin_main_back"));
            return;
        }

        const kb = new InlineKeyboard();
        candidates.forEach((c: any) => {
            const name = c.fullName || c.user.username || ADMIN_TEXTS["admin-search-no-name"];
            kb.text(`${name} (${c.status})`, `view_candidate_${c.id}`).row();
        });

        await ScreenManager.renderScreen(ctx, `Found ${candidates.length} candidates:`, kb);
        return;
    }

    if (step === "admin_search_staff") {
        if (!ctx.message.text) {
            await ScreenManager.renderScreen(ctx, "Enter text to search for a staff member.", new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-home"], "admin_main_back"));
            return;
        }
        const query = ctx.message.text.trim();
        ctx.session.step = "idle";
        if (ctx.session.adminFlow === "SEARCH") {
            delete ctx.session.adminFlow;
        }

        const staff = await staffService.searchStaff(query);
        if (staff.length === 0) {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-no-results"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-home"], "admin_main_back"));
            return;
        }

        const kb = new InlineKeyboard();
        for (const s of staff) {
            const label = staffService.formatStaffName(s.fullName);
            kb.text(label, `view_staff_${s.id}`).row();
        }

        await ScreenManager.renderScreen(ctx, `Found ${staff.length} staff members:`, kb);
        return;
    }

    await next();
});

async function handleAdminMessageSend(ctx: MyContext, userId: string) {
    const user = await userRepository.findById(userId);
    if (!user) return ctx.reply(ADMIN_TEXTS["admin-history-user-not-found"]);

    const messageTextStr = getAdminOutboundText(ctx.message) || "[Media Message]";

    const candidate = await candidateRepository.findByUserId(userId);
    const staff = await staffRepository.findByUserId(userId);

    const displayName = staff
        ? staffService.formatStaffName(staff.fullName)
        : (candidate?.fullName || user.username || `User ${user.telegramId}`);

    let createdTopicId: number | undefined;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasPermission } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    const canCreateTopic = !shouldUseDirectCandidateMessage(candidate)
        && (hasPermission(role, 'SUPPORT_CHAT') || hasPermission(role, 'MENTOR_ONBOARDING'));

    if (SUPPORT_CHAT_ID && canCreateTopic) {
        try {
            const existingTopic = await supportRepository.findActiveOutgoingTopicByUser(user.id);
            const location = staff?.location || candidate?.location;

            if (existingTopic) {
                createdTopicId = existingTopic.topicId;
            } else {
                const surname = displayName.split(' ')[0] || displayName;
                const formattedLocation = location
                    ? formatLocationName(location.name, location.city)
                    : '';
                let locationPart = '';
                if (formattedLocation) locationPart = ` | ${formattedLocation}`;

                const isOnboarding = candidate?.status === 'STAGING_ACTIVE' || candidate?.status === 'DISCOVERY_SCHEDULED' || candidate?.status === 'TRAINING_SCHEDULED' || candidate?.status === 'TRAINING_COMPLETED';
                const prefix = isOnboarding ? '🎓 ONBOARDING' : '📤';
                const topicTitle = `${prefix} | ${surname}${locationPart}`;
                const topic = await ctx.api.createForumTopic(SUPPORT_CHAT_ID, topicTitle);
                createdTopicId = topic.message_thread_id;

                let locationText = '';
                if (formattedLocation) locationText = `📍 ${formattedLocation}`;
                const phone = staff?.phone || candidate?.phone;
                const phoneText = phone
                    ? `📞 <code>${escapeHtml(phone)}</code>`
                    : '';

                const infoCard =
                    `👤 <b>${displayName}</b>\n` +
                    (phoneText ? `${phoneText}\n` : '') +
                    (locationText ? `${locationText}\n` : '') +
                    `🕐 ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}\n\n` +
                    `<i>${ADMIN_TEXTS["admin-topic-info-outgoing"]}</i>`;

                const topicActions = new InlineKeyboard()
                    .text(ADMIN_TEXTS["admin-topic-btn-fwd"], `forward_to_kuznetsov_${topic.message_thread_id}`)
                    .text(ADMIN_TEXTS["admin-topic-btn-close"], `close_topic_${topic.message_thread_id}`).danger();

                await ctx.api.sendMessage(SUPPORT_CHAT_ID, infoCard, {
                    message_thread_id: topic.message_thread_id,
                    parse_mode: "HTML",
                    reply_markup: topicActions
                });

                await supportRepository.createOutgoingTopic({
                    chatId: BigInt(SUPPORT_CHAT_ID),
                    topicId: topic.message_thread_id,
                    staffName: displayName,
                    userId: user.id,
                });
            }
            await sendAdminOutboundMessage(ctx, SUPPORT_CHAT_ID, {
                messageThreadId: createdTopicId,
                prefixText: false,
            });
        } catch (e: any) {
            logger.error({ err: e, topicId: createdTopicId, supportChatId: SUPPORT_CHAT_ID }, "Admin conversation topic bootstrap failed");
        }
    }

    try {
        let outboundReplyMarkup: InlineKeyboard | undefined;
        if (candidate && candidate.gender !== "male") {
            outboundReplyMarkup = new InlineKeyboard().text("💬 Відповісти", "contact_hr");
        }
        await sendAdminOutboundMessage(
            ctx,
            Number(user.telegramId),
            outboundReplyMarkup ? { replyMarkup: outboundReplyMarkup } : undefined
        );
        await ctx.deleteMessage().catch(() => { });

        const { timelineRepository } = await import("../../repositories/timeline-repository.js");
        await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', messageTextStr, {
            adminId: ctx.from?.id,
            adminName: ctx.from?.first_name,
            directMessage: true
        });

        let replyText = ADMIN_TEXTS["admin-msg-success"];
        const replyMarkup = new InlineKeyboard();

        if (SUPPORT_CHAT_ID && createdTopicId) {
            try {
                const chatIdStr = String(SUPPORT_CHAT_ID);
                const cleanChatId = chatIdStr.startsWith('-100')
                    ? chatIdStr.substring(4)
                    : chatIdStr.replace('-', '');

                const topicLink = `https://t.me/c/${cleanChatId}/${createdTopicId}`;
                replyMarkup.url(ADMIN_TEXTS["support-btn-go-to-topic"], topicLink).row();
            } catch (e: any) { }
        }

        // Add specific back button
        if (staff) {
            replyMarkup.text("👤 Back to Profile", `view_staff_${staff.id}`).row();
        } else if (candidate) {
            replyMarkup.text("👤 Back to Profile", getCandidateBackCallback(ctx, candidate.id)).row();
        }

        replyMarkup.text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");
        await ScreenManager.renderScreen(ctx, replyText, replyMarkup);
    } catch (e: any) {
        logger.error({ err: e, userId: user.id, telegramId: user.telegramId }, "Admin message delivery failed");
        const errKb = new InlineKeyboard();
        if (staff) errKb.text("👤 Back to Profile", `view_staff_${staff.id}`).row();
        else if (candidate) errKb.text("👤 Back to Profile", getCandidateBackCallback(ctx, candidate.id)).row();
        errKb.text(ADMIN_TEXTS["admin-btn-main-menu"], "admin_main_menu");

        await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-msg-err-delivery"], errKb);
    }
}

export async function handleAdminTimelineExport(ctx: MyContext, userId: string) {
    const { ADMIN_IDS } = await import("../../config.js");
    if (!ADMIN_IDS.includes(Number(ctx.from?.id))) {
        return ctx.answerCallbackQuery(ADMIN_TEXTS["admin-err-super-admin-only"]).catch(() => { });
    }

    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-gen-report"]).catch(() => { });

    try {
        const { adminService } = await import("../../services/admin-service.js");
        const report = await adminService.generateFullTimeline(userId);

        const { Buffer } = await import("buffer");
        const fileData = Buffer.from(report, 'utf-8');

        const { InputFile } = await import("grammy");
        await ctx.replyWithDocument(new InputFile(fileData, `timeline_${userId}.txt`), {
            caption: ADMIN_TEXTS["admin-timeline-history-caption"]
        });

    } catch (e: any) {
        logger.error({ err: e, userId }, "Admin timeline export failed");
        await ctx.reply(`❌ Export failed: ${e.message}`);
    }
}
