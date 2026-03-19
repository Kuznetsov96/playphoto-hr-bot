import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";

export const supportHandlers = new Composer<MyContext>();

// --- CALLBACKS ---

// START SUPPORT FLOW
supportHandlers.callbackQuery("contact_hr", async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    // 1. Check if candidate exists
    const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
    if (!candidate) {
        return ctx.answerCallbackQuery("Error: Candidate profile not found.");
    }

    ctx.session.step = "support_chat";
    await ctx.answerCallbackQuery();

    const kb = new InlineKeyboard().text("❌ Скасувати", "end_support_chat");
    await ctx.reply(
        `<b>Напишіть ваше питання або повідомлення нижче ⤵️</b>\n` +
        `Ми одразу передамо його відповідальній особі, і ви отримаєте відповідь прямо тут. ✨`,
        { parse_mode: "HTML", reply_markup: kb }
    );
});

// END SUPPORT FLOW
supportHandlers.callbackQuery("end_support_chat", async (ctx) => {
    ctx.session.step = "idle";
    await ctx.editMessageText("Діалог завершено. Якщо захочете написати знову — натисніть кнопку 'Написати нам'. 🌸");
    await ctx.answerCallbackQuery();
});

export async function handleSupportMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const step = ctx.session.step || "idle";
    if (step !== "support_chat") return false;

    if (!ctx.message?.text && !ctx.message?.photo && !ctx.message?.voice && !ctx.message?.video) return false;

    try {
        const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
        if (!candidate || !candidate.user) return false;

        const { MENTOR_IDS, HR_IDS, ADMIN_IDS, TEAM_CHATS } = await import("../config.js");
        const { supportService } = await import("../services/support-service.js");
        const { supportRepository } = await import("../repositories/support-repository.js");
        
        const isMentorStage = [
            'ACCEPTED', 'DISCOVERY_SCHEDULED', 'DISCOVERY_COMPLETED',
            'TRAINING_SCHEDULED', 'TRAINING_COMPLETED', 'NDA', 'KNOWLEDGE_TEST',
            'AWAITING_FIRST_SHIFT', 'READY_FOR_HIRE'
        ].includes(candidate.status) || candidate.hrDecision === 'ACCEPTED' || candidate.materialsSent;

        const isStagingStage = ['STAGING_SETUP', 'STAGING_ACTIVE', 'OFFLINE_STAGING'].includes(candidate.status);
        const isOnboarding = isStagingStage || isMentorStage;

        // Check if there's an active ticket or outgoing topic for the candidate
        const activeTicket = await supportRepository.findActiveTicketByUser(candidate.user.id);
        const activeOutgoingTopic = !activeTicket ? await supportRepository.findActiveOutgoingTopicByUser(candidate.user.id) : null;

        // If they already have an active TOPIC in Support group, just forward there
        if ((activeTicket && activeTicket.topicId) || activeOutgoingTopic) {
            const topicId = activeTicket?.topicId || activeOutgoingTopic?.topicId;
            try {
                if (ctx.message && topicId) {
                    await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id, {
                        message_thread_id: topicId
                    });
                     // Touch updatedAt
                    if (activeTicket) await supportRepository.touchTicket(activeTicket.id).catch(() => {});
                    // Log to Timeline
                    const { timelineRepository } = await import("../repositories/timeline-repository.js");
                    await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', ctx.message?.text || ctx.message?.caption || "[Media]", {
                        ticketId: activeTicket?.id,
                        outgoingTopicId: activeOutgoingTopic?.id
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "Failed to forward candidate message to topic");
                await ctx.reply("Сталася помилка при відправці повідомлення. Спробуйте пізніше.");
            }
            ctx.session.step = "idle";
            await ctx.reply("✅ Повідомлення надіслано! Ми відповімо найближчим часом. ✨");
            return true;
        }

        const msgText = ctx.message?.text || ctx.message?.caption || "[Media]";

        // If NO active topic, BUT they are in Onboarding stage, CREATE a SupportTicket and Topic!
        if (isOnboarding) {
            try {
                const ticket = await supportService.createTicket(candidate.user.id, msgText);
                
                // Create topic in Support chat
                const { buildTopicTitle, buildTicketCard, getTicketButtons } = await import("../utils/ticket-card.js");
                const locationCity = candidate.city || null;
                const locationName = candidate.location?.name || null;
                
                const topicTitle = buildTopicTitle(ticket.id, candidate.fullName || "Кандидат", locationName, "OPEN", false, false, locationCity);
                const topic = await ctx.api.createForumTopic(TEAM_CHATS.SUPPORT, topicTitle);
                await supportRepository.updateTicket(ticket.id, { topicId: topic.message_thread_id });

                const cardText = await buildTicketCard(
                    ticket, 
                    { telegramId: BigInt(telegramId), username: ctx.from?.username || null, staffProfile: null, candidate: candidate as any },
                    false, locationName, locationCity, true
                );
                
                // Only show Pass/Fail if they are strictly in Staging or Awaiting First Shift
                const isEvaluating = ['STAGING_ACTIVE', 'OFFLINE_STAGING', 'AWAITING_FIRST_SHIFT'].includes(candidate.status);
                const buttons = getTicketButtons(ticket.id, "OPEN", false, isEvaluating, candidate.id);

                await ctx.api.sendMessage(TEAM_CHATS.SUPPORT, cardText, {
                    message_thread_id: topic.message_thread_id,
                    parse_mode: "HTML",
                    reply_markup: buttons
                });

                if (ctx.message) {
                    await ctx.api.copyMessage(TEAM_CHATS.SUPPORT, ctx.chat!.id, ctx.message.message_id, {
                        message_thread_id: topic.message_thread_id
                    });
                }

                ctx.session.step = "idle";
                await ctx.reply("✅ Чат з ментором створено! Відповіді прийдуть прямо сюди. ✨");
                return true;
                
            } catch (e) {
                logger.error({ err: e }, "Failed to create onboarding topic for candidate");
                // IF it fails, fallback to standard DM forwarding below
            }
        }

        // --- FALLBACK / HR STAGE: Send DMs to responsible admins ---
        let categoryLabel = "HR";
        let targetAdminIds = HR_IDS;

        if (isStagingStage) {
            categoryLabel = "Admin (Staging)";
            targetAdminIds = ADMIN_IDS;
        } else if (isMentorStage) {
            categoryLabel = "Mentor";
            targetAdminIds = MENTOR_IDS;
        }

        if (targetAdminIds.length === 0) targetAdminIds = ADMIN_IDS;

        if (targetAdminIds.length === 0) {
            await ctx.reply("Вибачте, зараз немає активного адміністратора. Спробуйте пізніше.");
            return true;
        }

        const adminMsgText = 
            `💬 <b>Message from Candidate (${categoryLabel})</b>\n` +
            `👤 <b>${candidate.fullName || "Candidate"}</b> (@${candidate.user.username || "no_user"})\n` +
            `📍 City: ${candidate.city || "—"}\n\n` +
            `<b>Text:</b> ${msgText}`;

        const adminKb = new InlineKeyboard().text("✍️ Reply", `admin_reply_to_${telegramId}`);

        let delivered = false;
        for (const adminId of targetAdminIds) {
            try {
                await bot.api.sendMessage(Number(adminId), adminMsgText, {
                    parse_mode: "HTML",
                    reply_markup: adminKb
                });
                delivered = true;
            } catch (e) {}
        }

        if (!delivered && ADMIN_IDS.length > 0) {
            await bot.api.sendMessage(Number(ADMIN_IDS[0]!), adminMsgText, { parse_mode: "HTML", reply_markup: adminKb }).catch(() => {});
        }

        try {
            const { messageRepository } = await import("../repositories/message-repository.js");
            const { timelineRepository } = await import("../repositories/timeline-repository.js");
            
            await messageRepository.create({
                candidate: { connect: { id: candidate.id } },
                sender: "USER",
                scope: isMentorStage ? "MENTOR" : "HR",
                content: msgText
            });

            await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', msgText, { category: categoryLabel });
            await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
        } catch (e) { }

        ctx.session.step = "idle";
        await ctx.reply("✅ Повідомлення надіслано! Ми відповімо найближчим часом. ✨");

        return true;

    } catch (e) {
        logger.error({ err: e }, "Error in handleSupportMessage");
        return false;
    }
}
