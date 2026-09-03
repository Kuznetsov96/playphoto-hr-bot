import { Composer, InlineKeyboard, type NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { hrService } from "../services/hr-service.js";
import { formatCandidateProfile } from "../utils/profile-formatter.js";
import logger from "../core/logger.js";
import { readCallbackPayload } from "../utils/signed-callback.js";
import { ScreenManager } from "../utils/screen-manager.js";

// NOTE: The recruiter's own HR hub (Inbox, Calendar, Hiring Needs, Broadcast Tools,
// Candidate Pools) was removed 2026-09-03 — the recruiter now works entirely in the
// web app. What remains here serves the owner/admin "Final Step Pipeline" flow
// (src/menus/hr.ts: hrFinalStepMenu and its candidate-detail submenus).

export const hrHandlers = new Composer<MyContext>();

async function renderHrCandidateUnified(ctx: MyContext, candId: string) {
    const candidate = await hrService.getCandidateDetails(candId);
    if (!candidate) {
        await ctx.reply("Candidate not found.");
        return;
    }

    ctx.session.candidateData = { id: candidate.id } as any;
    ctx.session.candidateProfileMenuId = "hr-candidate-unified";
    const text = await formatCandidateProfile(ctx as any, candidate as any, {
        includeActionLabel: true,
        actionLabel: "Please review the profile and make a decision:"
    });

    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
}

hrHandlers.callbackQuery(/^hr_back_candidate_(.+)$/, async (ctx) => {
    const candId = ctx.match[1]!;
    await ctx.answerCallbackQuery().catch(() => { });
    delete ctx.session.selectedSlotId;
    await renderHrCandidateUnified(ctx, candId);
});

hrHandlers.callbackQuery("nav_final_step_pipeline", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => { });
    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu", { pushToStack: true });
});

hrHandlers.callbackQuery("hr_cancel_withdraw_reject", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled").catch(() => { });
    const candId = ctx.session.candidateData?.id;
    if (!candId) return;
    await renderHrCandidateUnified(ctx, candId);
});

hrHandlers.on("callback_query:data", async (ctx, next) => {
    const candId = readCallbackPayload(ctx.callbackQuery.data, { code: "hwr" });
    if (!candId) return next();

    await ctx.answerCallbackQuery().catch(() => { });
    const result = await hrService.rejectCandidateWithdrawalFromStaging(ctx.api, candId);
    if (!result.ok) {
        await ctx.reply("Unable to reject candidate.");
        return;
    }

    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(
        ctx,
        `❌ <b>Candidate Rejected</b>\n\nThe application has been closed, staging has been cancelled, and the assigned partner has been notified.`,
        "hr-final-step-menu",
        { pushToStack: true }
    );
});

// Handle text input for HR/mentor replies to candidates (still used from the
// Final Step Pipeline candidate detail view's "Message" button).
hrHandlers.on("message:text", async (ctx: MyContext, next: NextFunction) => {
    const step = ctx.session.step || "";
    const text = ctx.msg?.text;
    if (!text) return next();

    if (step.startsWith("admin_reply_")) {
        const targetId = step.replace("admin_reply_", "");
        if (!/^\d+$/.test(targetId)) return next();

        try {
            const { candidateRepository } = await import("../repositories/candidate-repository.js");
            const cand = await candidateRepository.findByTelegramId(Number(targetId));
            const name = cand?.fullName?.split(' ')[0] || "Candidate";
            const { MENTOR_IDS } = await import("../config.js");
            const isMentor = MENTOR_IDS.includes(ctx.from!.id);
            const isMentorOwnedStage = !!cand && [
                "ACCEPTED",
                "MENTOR_MANUAL",
                "WAITLIST_MENTOR",
                "DISCOVERY_SCHEDULED",
                "DISCOVERY_COMPLETED",
                "TRAINING_SCHEDULED",
                "TRAINING_COMPLETED",
                "AWAITING_FIRST_SHIFT",
                "HIRED"
            ].includes(cand.status);
            const useMentorScope = isMentor && isMentorOwnedStage;

            const { InlineKeyboard } = await import("grammy");
            const msgOptions: Parameters<typeof ctx.api.sendMessage>[2] = { parse_mode: "HTML" };
            if (cand?.gender !== "male") {
                msgOptions.reply_markup = new InlineKeyboard().text("💬 Відповісти", useMentorScope ? "contact_mentor" : "contact_hr");
            }

            // Candidate message stays in Ukrainian
            await ctx.api.sendMessage(Number(targetId), `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${text}`, msgOptions);

            // Log to history and reset unread ONLY after success
            if (cand) {
                const { messageRepository } = await import("../repositories/message-repository.js");
                const scope = useMentorScope ? "MENTOR" : "HR";

                await messageRepository.create({
                    candidate: { connect: { id: cand.id } },
                    sender: useMentorScope ? "MENTOR" : "HR",
                    scope,
                    content: text
                });
                await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            }

            const successKb = new InlineKeyboard();
            if (cand) {
                successKb.text("👤 Back to Profile", `hr_back_candidate_${cand.id}`).row();
            }
            await ScreenManager.renderScreen(ctx, `✅ Message sent to ${name}! 🕊️`, successKb.inline_keyboard.length > 0 ? successKb : undefined);
            ctx.session.step = "idle";
        } catch (e: any) {
            if (e.description?.includes("forbidden") || e.description?.includes("blocked") || e.error_code === 403) {
                const { candidateRepository } = await import("../repositories/candidate-repository.js");
                const cand = await candidateRepository.findByTelegramId(Number(targetId));
                if (cand) {
                    await candidateRepository.update(cand.id, { status: "BLOCKER", hasUnreadMessage: false });
                    await ctx.reply(`🚫 <b>Candidate stopped the bot.</b>\n\nReply to <b>${cand.fullName}</b> is impossible. Her status has been changed to BLOCKER.`, { parse_mode: "HTML" });
                }
            } else {
                await ctx.reply(`❌ Send error: ${e.message}`);
            }
            ctx.session.step = "idle";
        }
        return;
    }

    await next();
});
