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

/**
 * Handles incoming messages related to support/messaging from CANDIDATES.
 * Direct person-to-person routing via Bot.
 */
export async function handleSupportMessage(ctx: MyContext, bot: Bot<MyContext>): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const step = ctx.session.step || "idle";
    if (step !== "support_chat") return false;

    // Ignore commands or empty media
    if (!ctx.message?.text && !ctx.message?.photo && !ctx.message?.voice && !ctx.message?.video) return false;

    try {
        const candidate = await candidateRepository.findByTelegramId(Number(telegramId));
        if (!candidate || !candidate.user) return false;

        const { MENTOR_IDS, HR_IDS, ADMIN_IDS } = await import("../config.js");
        
        // Contextual Routing Logic (Apple Style: Precise Role Responsibility)
        let categoryLabel = "HR";
        let targetAdminIds = HR_IDS;

        const isMentorStage = [
            'ACCEPTED', 
            'DISCOVERY_SCHEDULED',
            'DISCOVERY_COMPLETED',
            'TRAINING_SCHEDULED', 
            'TRAINING_COMPLETED',
            'NDA',
            'KNOWLEDGE_TEST',
            'AWAITING_FIRST_SHIFT',
            'READY_FOR_HIRE'
        ].includes(candidate.status) || 
        candidate.hrDecision === 'ACCEPTED' || // Immediate transition after HR decision
        candidate.materialsSent;

        const isStagingStage = candidate.status === 'STAGING_SETUP' || candidate.status === 'STAGING_ACTIVE' || candidate.status === 'OFFLINE_STAGING';

        if (isStagingStage) {
            categoryLabel = "Admin (Staging)";
            targetAdminIds = ADMIN_IDS;
        } else if (isMentorStage) {
            categoryLabel = "Mentor";
            targetAdminIds = MENTOR_IDS;
        }

        // Fallback to Admin if no IDs configured
        if (targetAdminIds.length === 0) targetAdminIds = ADMIN_IDS;

        if (targetAdminIds.length === 0) {
            await ctx.reply("Вибачте, зараз немає активного адміністратора. Спробуйте пізніше.");
            return true;
        }

        // Forward Message to all responsible Admins
        const adminMsgText = 
            `💬 <b>Message from Candidate (${categoryLabel})</b>\n` +
            `👤 <b>${candidate.fullName || "Candidate"}</b> (@${candidate.user.username || "no_user"})\n` +
            `📍 City: ${candidate.city || "—"}\n\n` +
            `<b>Text:</b> ${ctx.message?.text || ctx.message?.caption || "[Media]"}`;

        const adminKb = new InlineKeyboard().text("✍️ Reply", `admin_reply_to_${telegramId}`);

        let delivered = false;
        for (const adminId of targetAdminIds) {
            try {
                await bot.api.sendMessage(adminId, adminMsgText, {
                    parse_mode: "HTML",
                    reply_markup: adminKb
                });
                delivered = true;
            } catch (e) {
                logger.error({ err: e, adminId }, "Failed to deliver message to specific admin");
            }
        }

        if (!delivered && ADMIN_IDS.length > 0) {
            // Last resort: send to the very first admin in config
            await bot.api.sendMessage(ADMIN_IDS[0]!, adminMsgText, { parse_mode: "HTML", reply_markup: adminKb }).catch(() => {});
        }

        // Log to History & Timeline
        try {
            const { messageRepository } = await import("../repositories/message-repository.js");
            const { timelineRepository } = await import("../repositories/timeline-repository.js");
            
            await messageRepository.create({
                candidate: { connect: { id: candidate.id } },
                sender: "USER",
                scope: isMentorStage ? "MENTOR" : "HR",
                content: ctx.message?.text || ctx.message?.caption || "[Media Message]"
            });

            await timelineRepository.createEvent(candidate.user.id, 'MESSAGE', 'USER', ctx.message?.text || ctx.message?.caption || "[Media Message]", {
                category: categoryLabel
            });
            
            await candidateRepository.update(candidate.id, { hasUnreadMessage: true });
        } catch (e) {
            logger.error({ err: e }, "Failed to log support message to DB");
        }

        ctx.session.step = "idle"; // Reset to idle after sending one message
        await ctx.reply("✅ Повідомлення надіслано! Ми відповімо найближчим часом. ✨");

        return true;

    } catch (e) {
        logger.error({ err: e }, "Error in handleSupportMessage");
        return false;
    }
}
