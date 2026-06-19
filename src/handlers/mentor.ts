import { Composer, InlineKeyboard, type NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { mentorRootMenu, mentorHubMenu, mentorManualTrainingDateMenu, updateCalendarDashboard } from "../menus/mentor.js";
import { requireRole } from "../middleware/role-check.js";
import { mentorService } from "../services/mentor-service.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { escapeHtml } from "./admin/utils.js";
import { CandidateStatus } from "@prisma/client";

export const mentorHandlers = new Composer<MyContext>();

// --- AUTH & MENU REGISTRATION ---
const protectedMenu = new Composer<MyContext>();
const protectedCallbacks = protectedMenu.filter(c => 
    c.has("callback_query:data") && 
    (c.callbackQuery.data.startsWith("mentor_") || c.callbackQuery.data.startsWith("mentor-") || c.callbackQuery.data.startsWith("mentor:"))
);

protectedCallbacks.use(requireRole('SUPER_ADMIN', 'MENTOR_LEAD'));
protectedCallbacks.use(mentorRootMenu);
mentorHandlers.use(protectedMenu);

// --- TEXT INPUT HANDLERS (SMI Pattern) ---
mentorHandlers.on("message:text", async (ctx: MyContext, next: NextFunction) => {
    const text = ctx.message!.text!.trim();
    const step = ctx.session.step || "";

    if (text.startsWith("/")) return next();

    // Staff mentors do not pass through hrHandlers, so mentor replies need local handling.
    if (step.startsWith("admin_reply_")) {
        const targetId = step.replace("admin_reply_", "");
        if (!/^\d+$/.test(targetId)) return next();

        try {
            const cand = await candidateRepository.findByTelegramId(Number(targetId));
            const name = cand?.fullName?.split(" ")[0] || "Candidate";

            const msgOptions: Parameters<typeof ctx.api.sendMessage>[2] = { parse_mode: "HTML" };
            if (cand?.gender !== "male") {
                msgOptions.reply_markup = new InlineKeyboard().text("💬 Відповісти", "contact_mentor");
            }

            await ctx.api.sendMessage(
                Number(targetId),
                `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${escapeHtml(text)}`,
                msgOptions
            );

            if (cand) {
                const { messageRepository } = await import("../repositories/message-repository.js");
                await messageRepository.create({
                    candidate: { connect: { id: cand.id } },
                    sender: "MENTOR",
                    scope: "MENTOR",
                    content: text
                });
                await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            }

            await ScreenManager.renderScreen(ctx, `✅ Message sent to ${name}.`, "mentor-action-success");
        } catch (e: any) {
            if (e.description?.includes("forbidden") || e.description?.includes("blocked") || e.error_code === 403) {
                const cand = await candidateRepository.findByTelegramId(Number(targetId));
                if (cand) {
                    await candidateRepository.update(cand.id, { status: CandidateStatus.BLOCKER, hasUnreadMessage: false });
                    await ScreenManager.renderScreen(ctx, `🚫 <b>Candidate stopped the bot.</b>\n\nReply to <b>${cand.fullName}</b> is impossible. Her status has been changed to BLOCKER.`);
                }
            } else {
                await ScreenManager.renderScreen(ctx, `❌ Send error: ${e.message}`);
            }
        }

        ctx.session.step = "idle";
        return;
    }

    // 1. Handle manual time for Discovery/Internship
    if (step.startsWith("wait_mentor_manual_time_")) {
        await ctx.deleteMessage().catch(() => {});
        const [candId, date, type] = step.replace("wait_mentor_manual_time_", "").split("_");
        
        if (!/^(\d{1,2}):(\d{2})$/.test(text)) {
            return await ScreenManager.renderScreen(ctx, "❌ Format error. Try again (HH:MM):");
        }

        try {
            const cand = await candidateRepository.findById(candId!);
            if (!cand) return await ScreenManager.renderScreen(ctx, "❌ Candidate not found.");

            const result = type === 'discovery'
                ? await mentorService.bookDiscoverySlotFromText(candId!, `${date} ${text}`)
                : await mentorService.bookTrainingSlotFromText(candId!, `${date} ${text}`);

            if (!result.success) {
                await ScreenManager.renderScreen(ctx, (result as any).error || "❌ Format error. Try again (HH:MM):");
                return;
            }

            if (result.notification) {
                await ctx.api.sendMessage(result.notification.telegramId, result.notification.text, {
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true }
                }).catch(() => {});
            }

            await ScreenManager.renderScreen(ctx, `✅ <b>Scheduled for ${date} ${text}!</b>\n\nCandidate has been notified.`, "mentor-action-success");
            ctx.session.step = "idle";
        } catch (e: any) {
            logger.error({ err: e }, "Failed to book manual mentor slot");
            await ScreenManager.renderScreen(ctx, `❌ Error: ${e.message}`);
        }
        return;
    }

    // 2. Handle custom time for existing date
    if (step.startsWith("wait_mentor_custom_time_")) {
        await ctx.deleteMessage().catch(() => {});
        const [candId, date] = step.replace("wait_mentor_custom_time_", "").split("_");
        
        if (ctx.session.adminFlow === 'SCHEDULE') {
            // Update firstShiftDate instead of booking training
            const [day, month, year] = date!.split('.').map(Number);
            const [hour, min] = text.split(':').map(Number);
            const { createKyivDate } = await import("../utils/bot-utils.js");
            const newDate = createKyivDate(year || new Date().getFullYear(), month! - 1, day!, hour!, min!);
            
            await candidateRepository.update(candId!, { 
                firstShiftDate: newDate,
                firstShiftTime: text 
            });
            
            await ScreenManager.renderScreen(ctx, `✅ <b>First shift date updated to ${date} ${text}!</b>`, "mentor-action-success");
            ctx.session.step = "idle";
            ctx.session.adminFlow = undefined;
            return;
        }

        const candForCustomTime = await candidateRepository.findById(candId!);
        const isDiscoveryReschedule = candForCustomTime?.status === "DISCOVERY_SCHEDULED";
        const result = isDiscoveryReschedule
            ? await mentorService.bookDiscoverySlotFromText(candId!, `${date} ${text}`)
            : await mentorService.bookTrainingSlotFromText(candId!, `${date} ${text}`);

        if (result.success) {
            if (result.notification) {
                await ctx.api.sendMessage(result.notification.telegramId, result.notification.text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
            }
            await ScreenManager.renderScreen(ctx, `✅ <b>Scheduled for ${date} ${text}!</b>\n\nCandidate has been notified.`, "mentor-action-success");
            ctx.session.step = "idle";
        } else {
            await ScreenManager.renderScreen(ctx, (result as any).error || "❌ Format error. Try again (HH:MM):");
        }
        return;
    }

    await next();
});

// --- CALLBACK HANDLERS ---

mentorHandlers.callbackQuery(/^mentor_discovery_passed_(.+)$/, async (ctx) => {
    const candId = ctx.match![1]!;
    const res = await mentorService.completeDiscovery(ctx.api, candId, 'passed');
    if (res) {
        ctx.session.selectedCandidateId = candId;
        await ScreenManager.renderScreen(ctx, `✨ <b>Discovery Passed!</b>\n\nNow please select the <b>Online Internship Date</b> for ${res.candidate.fullName}:`, "mentor-manual-date", { pushToStack: true });
    } else {
        await ctx.answerCallbackQuery("❌ Candidate not found.");
    }
});

mentorHandlers.callbackQuery(/^mentor_nav_manual_training_(.+)$/, async (ctx) => {
    const candId = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    ctx.session.selectedCandidateId = candId;
    const cand = await candidateRepository.findById(candId);
    await ScreenManager.renderScreen(ctx, `🗓 <b>Assign Online Internship</b>\n\nPlease select the date for ${cand?.fullName || 'Candidate'}:`, "mentor-manual-date", { pushToStack: true });
});

mentorHandlers.callbackQuery("mentor_train_calendar", async (ctx) => {
    await ctx.answerCallbackQuery();
    await updateCalendarDashboard(ctx);
});

mentorHandlers.callbackQuery("mentor_back_calendar_root", async (ctx) => {
    await ctx.answerCallbackQuery();
    await updateCalendarDashboard(ctx);
});
