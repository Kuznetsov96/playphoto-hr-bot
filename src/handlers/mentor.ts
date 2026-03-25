import { Composer, InlineKeyboard, type NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { mentorRootMenu, mentorHubMenu, mentorManualTrainingDateMenu, updateCalendarDashboard } from "../menus/mentor.js";
import { requireRole } from "../middleware/role-check.js";
import { mentorService } from "../services/mentor-service.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";
import { candidateRepository } from "../repositories/candidate-repository.js";

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

    // 1. Handle manual time for Discovery/Internship
    if (step.startsWith("wait_mentor_manual_time_")) {
        await ctx.deleteMessage().catch(() => {});
        const [candId, date, type] = step.replace("wait_mentor_manual_time_", "").split("_");
        
        if (!/^(\d{1,2}):(\d{2})$/.test(text)) {
            return await ScreenManager.renderScreen(ctx, "❌ Format error. Try again (HH:MM):");
        }

        try {
            const { bookingService } = await import("../services/booking-service.js");
            const { accessService } = await import("../services/access-service.js");
            const { KNOWLEDGE_BASE_LINK } = await import("../config.js");
            const { createKyivDate } = await import("../utils/bot-utils.js");

            const cand = await candidateRepository.findById(candId!);
            if (!cand) return await ScreenManager.renderScreen(ctx, "❌ Candidate not found.");

            const [day, month, year] = date!.split('.').map(Number);
            const [hour, min] = text.split(':').map(Number);
            const start = createKyivDate(year || new Date().getFullYear(), month! - 1, day!, hour!, min!);
            const end = new Date(start.getTime() + 20 * 60 * 1000);

            const session = await mentorService.createTrainingSessionDirect(start, end);
            const slot = await mentorService.createTrainingSlotDirect(start, end, session.id);

            const tid = Number(cand.user.telegramId);
            if (type === 'discovery') {
                await bookingService.bookDiscoverySlot(tid, slot.id);
                await ctx.api.sendMessage(tid, CANDIDATE_TEXTS["mentor-manual-discovery-assigned"](date!, text), { parse_mode: "HTML" });
            } else {
                await bookingService.bookTrainingSlot(tid, slot.id);
                const channelLink = await accessService.createInviteLink(cand.user.telegramId) || "https://t.me/+FuFRMGsvMktkNGFi";
                await ctx.api.sendMessage(tid, CANDIDATE_TEXTS["training-manual-invite"](date!, text, channelLink, KNOWLEDGE_BASE_LINK), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
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
