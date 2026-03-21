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
import { escapeHtml } from "./utils.js";
import logger from "../../core/logger.js";
import { ScreenManager } from "../../utils/screen-manager.js";

export const adminSearchHandlers = new Composer<MyContext>();

export async function startAdminMessageFlow(ctx: MyContext, userId: string) {
    // MUST answer the callback query first to prevent Telegram loading spinner
    await ctx.answerCallbackQuery().catch(() => {});

    ctx.session.adminFlow = 'SEARCH';
    delete ctx.session.taskData;
    delete ctx.session.broadcastData;

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
    const canCreateTopic = hasPermission(role, 'SUPPORT_CHAT') || hasPermission(role, 'MENTOR_ONBOARDING');

    ctx.session.step = `admin_msg_${userId}`;

    const text = `Write message for <b>${displayName}</b>: ✉️\n\n` +
        (canCreateTopic
            ? `<i>A support ticket and topic will be created automatically after sending.</i>`
            : `<i>Message will be delivered directly to the user.</i>`);

    await ScreenManager.renderScreen(
        ctx,
        text,
        new InlineKeyboard().text(ADMIN_TEXTS["btn-cancel"], "admin_main_back"),
        { pushToStack: true }
    );
}

export async function startAdminSearch(ctx: MyContext) {
    ctx.session.adminFlow = 'SEARCH';
    delete ctx.session.taskData;
    delete ctx.session.broadcastData;
    ctx.session.step = "admin_search_cand";
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-cand-prompt"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step"), { pushToStack: true });
}

export async function startAdminStaffSearch(ctx: MyContext) {
    ctx.session.adminFlow = 'SEARCH';
    delete ctx.session.taskData;
    delete ctx.session.broadcastData;
    ctx.session.step = "admin_search_staff";
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-staff-prompt"], new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-cancel"], "cancel_step"), { pushToStack: true });
}

adminSearchHandlers.callbackQuery(/^admin_reply_to_(.+)$/, async (ctx) => {
    const telegramId = ctx.match![1]!;
    await ctx.answerCallbackQuery();

    ctx.session.step = `admin_reply_direct_${telegramId}`;
    await ScreenManager.renderScreen(ctx, `Write response for candidate (ID: ${telegramId}): ✍️\n\n<i>Message will be delivered directly to her bot chat.</i>`, new InlineKeyboard().text(ADMIN_TEXTS["btn-cancel"], "cancel_step"), { pushToStack: true });
});

adminSearchHandlers.callbackQuery(/^forward_to_kuznetsov_(.+)$/, async (ctx) => {
    const topicId = Number(ctx.match![1]!);
    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-topic-ans-fwd-ok"]);

    const kuznetsovId = ADMIN_IDS[0];
    if (!kuznetsovId) {
        logger.error("[ADMIN_FWD] Kuznetsov ID not found in ADMIN_IDS");
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
            
            logger.info({ topicId, kuznetsovId }, "[ADMIN_FWD] Forwarded topic card with Go to Topic button");
        } catch (e: any) {
            logger.error({ err: e }, "[ADMIN_FWD] Failed to copy/edit message to Kuznetsov");
        }
    }
});

adminSearchHandlers.on("message:text", async (ctx, next) => {
    const step = ctx.session.step || "";

    if (step.startsWith("admin_reply_direct_") || step.startsWith("admin_msg_") || step === "admin_search_cand" || step === "admin_search_staff") {
        await ctx.deleteMessage().catch(() => { });
    }

    if (step.startsWith("admin_reply_direct_")) {
        const targetTgId = step.replace("admin_reply_direct_", "");
        const messageText = ctx.message!.text!;

        try {
            const user = await userRepository.findByTelegramId(BigInt(targetTgId));
            if (!user) throw new Error("User not found in DB");

            // 1. Deliver to User — include a reply button so candidate can respond without funnel interception
            const replyKb = new InlineKeyboard().text("💬 Відповісти", "contact_hr");
            await ctx.api.sendMessage(Number(targetTgId), `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${messageText}`, {
                parse_mode: "HTML",
                reply_markup: replyKb
            });

            // 2. Log to Timeline
            const { timelineRepository } = await import("../../repositories/timeline-repository.js");
            await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', messageText, {
                adminId: ctx.from?.id,
                adminName: ctx.from?.first_name,
                directReply: true
            });

            // 3. Mark unread as handled if candidate
            const candidate = await candidateRepository.findByUserId(user.id);
            if (candidate) {
                await candidateRepository.update(candidate.id, { hasUnreadMessage: false });
            }

            const kb = new InlineKeyboard();
            if (candidate) kb.text("👤 Back to Profile", `view_candidate_${candidate.id}`).row();
            else {
                const staff = await staffRepository.findByUserId(user.id);
                if (staff) kb.text("👤 Back to Profile", `view_staff_${staff.id}`).row();
            }
            kb.text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities");

            await ScreenManager.renderScreen(ctx, "✅ Response sent successfully!", kb);
            ctx.session.step = "idle";
        } catch (e: any) {
            logger.error({ err: e }, "Failed to send direct reply");
            await ScreenManager.renderScreen(ctx, `❌ Failed to send: ${e.message}`);
        }
        return;
    }

    if (step.startsWith("admin_msg_")) {
        const userId = step.replace("admin_msg_", "");
        const text = ctx.message.text;
        ctx.session.step = "idle";
        await handleAdminMessageSend(ctx, userId, text);
        return;
    }

    if (step === "admin_search_cand") {
        const query = ctx.message.text.trim();
        ctx.session.step = "idle";

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
        const query = ctx.message.text.trim();
        ctx.session.step = "idle";

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

async function handleAdminMessageSend(ctx: MyContext, userId: string, messageTextStr: string) {
    const user = await userRepository.findById(userId);
    if (!user) return ctx.reply(ADMIN_TEXTS["admin-history-user-not-found"]);

    const candidate = await candidateRepository.findByUserId(userId);
    const staff = await staffRepository.findByUserId(userId);

    const displayName = staff
        ? staffService.formatStaffName(staff.fullName)
        : (candidate?.fullName || user.username || `User ${user.telegramId}`);

    let createdTopicId: number | undefined;

    const { getUserAdminRole } = await import("../../middleware/role-check.js");
    const { hasPermission } = await import("../../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));
    const canCreateTopic = hasPermission(role, 'SUPPORT_CHAT') || hasPermission(role, 'MENTOR_ONBOARDING');

    if (SUPPORT_CHAT_ID && canCreateTopic) {
        try {
            const existingTopic = await supportRepository.findActiveOutgoingTopicByUser(user.id);
            const location = staff?.location || candidate?.location;

            if (existingTopic) {
                createdTopicId = existingTopic.topicId;
            } else {
                const surname = displayName.split(' ')[0] || displayName;
                let locationPart = '';
                if (location) locationPart = ` | ${location.name} (${location.city})`;

                const isOnboarding = candidate?.status === 'STAGING_ACTIVE' || candidate?.status === 'DISCOVERY_SCHEDULED' || candidate?.status === 'TRAINING_SCHEDULED' || candidate?.status === 'TRAINING_COMPLETED';
                const prefix = isOnboarding ? '🎓 ONBOARDING' : '📤';
                const topicTitle = `${prefix} | ${surname}${locationPart}`;
                const topic = await ctx.api.createForumTopic(SUPPORT_CHAT_ID, topicTitle);
                createdTopicId = topic.message_thread_id;

                let locationText = '';
                if (location) locationText = `📍 ${location.name} (${location.city})`;

                const infoCard =
                    `👤 <b>${displayName}</b>\n` +
                    (locationText ? `${locationText}\n` : '') +
                    `🕐 ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}\n\n` +
                    `<i>${ADMIN_TEXTS["admin-topic-info-outgoing"]}</i>`;

                const topicActions = new InlineKeyboard()
                    .text(ADMIN_TEXTS["admin-topic-btn-fwd"], `forward_to_kuznetsov_${topic.message_thread_id}`)
                    .text(ADMIN_TEXTS["admin-topic-btn-close"], `close_topic_${topic.message_thread_id}`);

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

            const escapedText = escapeHtml(messageTextStr);
            await ctx.api.sendMessage(SUPPORT_CHAT_ID, escapedText, {
                message_thread_id: createdTopicId,
                parse_mode: "HTML"
            });
        } catch (e: any) {
            logger.error(`❌ [ADMIN_CONV] Failed to create topic: ${e.message}`);
        }
    }

    try {
        const replyKb = new InlineKeyboard().text("💬 Відповісти", "contact_hr");
        await ctx.api.sendMessage(Number(user.telegramId), `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${escapeHtml(messageTextStr)}`, {
            parse_mode: "HTML",
            reply_markup: replyKb
        });

        const { timelineRepository } = await import("../../repositories/timeline-repository.js");
        await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', messageTextStr, {
            adminId: ctx.from?.id,
            adminName: ctx.from?.first_name,
            directMessage: true
        });

        let replyText = ADMIN_TEXTS["admin-msg-success"];
        let replyMarkup = new InlineKeyboard();

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
            replyMarkup.text("👤 Back to Profile", `view_candidate_${candidate.id}`).row();
        }

        replyMarkup.text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities");
        await ScreenManager.renderScreen(ctx, replyText, replyMarkup);
    } catch (e: any) {
        logger.error(`❌ [ADMIN_CONV] Delivery failed for ${user.id}: ${e.message}`);
        const errKb = new InlineKeyboard();
        if (staff) errKb.text("👤 Back to Profile", `view_staff_${staff.id}`).row();
        else if (candidate) errKb.text("👤 Back to Profile", `view_candidate_${candidate.id}`).row();
        errKb.text(ADMIN_TEXTS["admin-btn-back-to-cities"], "admin_back_to_cities");

        await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-msg-err-delivery"], errKb);
    }
}

export async function handleAdminTimelineExport(ctx: MyContext, userId: string) {
    const { ADMIN_IDS } = await import("../../config.js");
    if (!ADMIN_IDS.includes(Number(ctx.from?.id))) {
        return ctx.answerCallbackQuery(ADMIN_TEXTS["admin-err-super-admin-only"]);
    }

    await ctx.answerCallbackQuery(ADMIN_TEXTS["admin-ans-gen-report"]);

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
        logger.error("Export failed:", e);
        await ctx.reply(`❌ Export failed: ${e.message}`);
    }
}
