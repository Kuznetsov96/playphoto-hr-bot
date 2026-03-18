import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { Bot, Composer, InlineKeyboard, type NextFunction } from "grammy";
import type { MyContext } from "../types/context.js";
import { hrHubMenu } from "../menus/hr.js";
import { interviewService } from "../services/interview-service.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { hrService } from "../services/hr-service.js";
import { createKyivDate } from "../utils/bot-utils.js";
import { formatCandidateProfile } from "../utils/profile-formatter.js";
import logger from "../core/logger.js";

export const hrHandlers = new Composer<MyContext>();

hrHandlers.callbackQuery(/^hr_view_candidate_(.+)$/, async (ctx) => {
    const candId = ctx.match[1]!;
    await ctx.answerCallbackQuery();

    const candidate = await hrService.getCandidateDetails(candId);
    if (!candidate) return ctx.reply("Candidate not found.");

    ctx.session.candidateData = { id: candidate.id } as any;
    ctx.session.viewingFromInbox = true; // Show 'Mark as Read' since this comes from notification
    delete ctx.session.selectedSlotId;

    const text = await formatCandidateProfile(ctx as any, candidate as any, {
        includeActionLabel: true,
        actionLabel: "Please review the profile and make a decision:"
    });

    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
});

hrHandlers.callbackQuery("hr_main_calendar", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const { ScreenManager } = await import("../utils/screen-manager.js");
        await ScreenManager.renderScreen(ctx, "🗓️ <b>Interview Calendar</b>\n\nSelect a date to manage slots: 👇", "hr-dashboard-dates", { pushToStack: true });
    } catch (e) {
        logger.error({ err: e }, "Failed to navigate to hr_main_calendar");
    }
});

hrHandlers.callbackQuery("nav_final_step_pipeline", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(ctx, "🚀 <b>Final Step Pipeline</b>", "hr-final-step-menu", { pushToStack: true });
});

hrHandlers.callbackQuery(/^view_candidate_new_(\d+)$/, async (ctx) => {
    const telegramId = Number(ctx.match![1]);
    await ctx.answerCallbackQuery();

    const candidate = await candidateRepository.findByTelegramId(telegramId);
    if (!candidate) return ctx.reply("Candidate not found.");

    ctx.session.candidateData = { id: candidate.id } as any;
    ctx.session.viewingFromInbox = true;
    delete ctx.session.selectedSlotId;

    const text = await formatCandidateProfile(ctx as any, candidate as any, {
        includeActionLabel: true,
        actionLabel: "Please review the profile and make a decision:"
    });

    const { ScreenManager } = await import("../utils/screen-manager.js");
    await ScreenManager.renderScreen(ctx, text, "hr-candidate-unified", { pushToStack: true });
});

hrHandlers.command("hr", async (ctx) => {
    const { getUserAdminRole } = await import("../middleware/role-check.js");
    const { hasAnyRole } = await import("../config/roles.js");
    const role = await getUserAdminRole(BigInt(ctx.from!.id));

    if (!hasAnyRole(role, 'SUPER_ADMIN', 'CO_FOUNDER', 'HR_LEAD')) {
        return ctx.reply("❌ No access rights.");
    }

    const { hrService } = await import("../services/hr-service.js");
    const { ScreenManager } = await import("../utils/screen-manager.js");
    const text = await hrService.getHubText();
    await ScreenManager.renderScreen(ctx, text, "hr-hub-menu", { pushToStack: true, forceNew: true });
});

// Handle text input for HR
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

            // Candidate message stays in Ukrainian
            await ctx.api.sendMessage(Number(targetId), `💬 <b>Відповідь адміністратора:</b>\n\n${text}`, { parse_mode: "HTML" });

            // Log to history and reset unread ONLY after success
            if (cand) {
                const { messageRepository } = await import("../repositories/message-repository.js");
                const { MENTOR_IDS } = await import("../config.js");
                const isMentor = MENTOR_IDS.includes(ctx.from!.id);
                const scope = isMentor ? "MENTOR" : "HR";

                await messageRepository.create({
                    candidate: { connect: { id: cand.id } },
                    sender: isMentor ? "MENTOR" : "HR",
                    scope,
                    content: text
                });
                await candidateRepository.update(cand.id, { hasUnreadMessage: false });
            }

            await ctx.reply(`✅ Message sent to ${name}! 🕊️`);
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

    if (step === "add_hr_time_unified") {
        const rangeRegex = /^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;
        const singleRegex = /^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/;

        const rangeMatch = text.match(rangeRegex);
        const singleMatch = text.match(singleRegex);
        const currentYear = new Date().getFullYear();

        if (rangeMatch) {
            const day = parseInt(rangeMatch[1]!);
            const month = parseInt(rangeMatch[2]!);
            const startH = parseInt(rangeMatch[3]!);
            const startM = parseInt(rangeMatch[4]!);
            const endH = parseInt(rangeMatch[5]!);
            const endM = parseInt(rangeMatch[6]!);

            const start = createKyivDate(currentYear, month - 1, day, startH, startM);
            const end = createKyivDate(currentYear, month - 1, day, endH, endM);

            if (start < new Date()) return ctx.reply(STAFF_TEXTS["hr-error-past-time"]);
            if (end <= start) return ctx.reply(STAFF_TEXTS["hr-error-end-before-start"]);

            try {
                // Now using 20 minutes as default from InterviewService update
                const { createdCount } = await interviewService.createSessionWithSlots(start, end);
                const { hrService } = await import("../services/hr-service.js");
                const stats = await hrService.getHubStats();
                const kb = new InlineKeyboard();
                if (stats.waitlistCount > 0) kb.text(`🔔 Notify Waitlist (${stats.waitlistCount})`, "hr_notify_waitlist").row();
                kb.text(STAFF_TEXTS["hr-btn-back-to-calendar"], "hr_main_calendar");
                await ctx.reply(STAFF_TEXTS["hr-success-created-slots"]({ count: createdCount, date: start.toLocaleDateString('uk-UA') }), { reply_markup: kb });
                ctx.session.step = "idle";
            } catch (e: any) {
                await ctx.reply(STAFF_TEXTS["hr-error-generic"]({ error: e.message }));
            }
            return;
        }

        if (singleMatch) {
            const day = parseInt(singleMatch[1]!);
            const month = parseInt(singleMatch[2]!);
            const startH = parseInt(singleMatch[3]!);
            const startM = parseInt(singleMatch[4]!);
            const start = createKyivDate(currentYear, month - 1, day, startH, startM);

            if (start < new Date()) return ctx.reply(STAFF_TEXTS["hr-error-past-time"]);

            try {
                await interviewService.createSingleSlot(start);
                const kb = new InlineKeyboard().text(STAFF_TEXTS["hr-btn-back-to-calendar"], "hr_main_calendar");
                await ctx.reply(`✅ Slot for ${start.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })} created and added to calendar!`, { reply_markup: kb });
                ctx.session.step = "idle";
            } catch (e: any) {
                await ctx.reply(STAFF_TEXTS["hr-error-generic"]({ error: e.message }));
            }
            return;
        }
    }

    if (step === "hr_assign_manual_slot") {
        const candId = ctx.session.candidateData?.id;
        if (!candId) {
            await ctx.reply("❌ Error: Candidate not selected.");
            ctx.session.step = "idle";
            return;
        }

        const regex = /^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/;
        const match = text.match(regex);
        if (match) {
            const day = parseInt(match[1]!);
            const month = parseInt(match[2]!);
            const hour = parseInt(match[3]!);
            const min = parseInt(match[4]!);
            const start = createKyivDate(new Date().getFullYear(), month - 1, day, hour, min);

            try {
                const dbSlot = await interviewService.createSingleSlot(start);
                await interviewService.bookSlot(dbSlot.id, candId);

                const cand = await candidateRepository.findById(candId);
                if (cand) {
                    await ctx.api.sendMessage(Number(cand.user.telegramId),
                        CANDIDATE_TEXTS["hr-manual-interview-assigned"](start.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })),
                        { parse_mode: "HTML" }
                    );
                }

                await ctx.reply(`✅ Interview scheduled for ${start.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}! Calendar updated.`);
                ctx.session.step = "idle";
            } catch (e: any) {
                await ctx.reply(`❌ Error: ${e.message}`);
            }
            return;
        }
    }
    await next();
});

// --- INDIVIDUAL INVITATION ---
hrHandlers.callbackQuery(/^invite_candidate_(.+)$/, async (ctx) => {
    const candId = ctx.match![1]!;
    const { hrService } = await import("../services/hr-service.js");
    try {
        await hrService.inviteCandidate(ctx.api, candId);
        await ctx.answerCallbackQuery(`✅ Invitation sent!`);
    } catch (e) {
        logger.error({ err: e }, "Failed to send individual invitation");
        await ctx.answerCallbackQuery("Send error ❌");
    }
});
