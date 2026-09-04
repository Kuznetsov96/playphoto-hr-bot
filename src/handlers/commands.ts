import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { ADMIN_IDS, MENTOR_IDS, CO_FOUNDER_IDS, ALLOW_DEV_COMMANDS } from "../config.js";
import { mentorHubMenu } from "../menus/mentor.js";
import { adminMenu } from "./admin/index.js";
import { cleanupMessages, trackMessage } from "../utils/cleanup.js";
import { checkBirthdays } from "../services/birthday-service.js";
import { userRepository } from "../repositories/user-repository.js";
import prisma from "../db/core.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { staffService } from "../modules/staff/services/index.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { requireRole, getUserAdminRole } from "../middleware/role-check.js";
import { updateUserCommands } from "../utils/command-manager.js";
import { startScreening } from "../modules/candidate/handlers/index.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";
import { logAuditEvent, logBusinessEvent } from "../core/log-events.js";
import { broadcastService } from "../services/broadcast.js";

import { accessService } from "../services/access-service.js";
import { formatLocation } from "../utils/location-label.js";

export const commandHandlers = new Composer<MyContext>();

const RESET_TESTER_IDS = [7096140693, 7455712248, 8253241676];
const RESET_TESTER_ID_BIGINTS = new Set(RESET_TESTER_IDS.map((id) => BigInt(id)));

async function showAdminCancelHome(ctx: MyContext, adminRole: NonNullable<Awaited<ReturnType<typeof getUserAdminRole>>>) {
    if (adminRole === 'SUPER_ADMIN' || adminRole === 'CO_FOUNDER' || adminRole === 'SUPPORT') {
        const text = await staffService.getAdminHeader(adminRole as any);
        await ScreenManager.renderScreen(ctx, text, "admin-main", { forceNew: true });
        return;
    }

    if (adminRole === 'HR_LEAD') {
        // The recruiter's own HR hub was removed 2026-09-03 — recruiting now happens
        // in the web app. HR_LEAD still has admin-shell access (search, etc.) via
        // the HR_MENU permission, so land there instead of a dead menu.
        const text = await staffService.getAdminHeader(adminRole as any);
        await ScreenManager.renderScreen(ctx, text, "admin-main", { forceNew: true });
        return;
    }

    if (adminRole === 'MENTOR_LEAD') {
        const { mentorService } = await import("../services/mentor-service.js");
        const text = await mentorService.getHubText();
        await ScreenManager.renderScreen(ctx, text, "mentor-hub-menu", { forceNew: true });
    }
}

// --- GLOBAL CALLBACKS ---
commandHandlers.callbackQuery("cancel_step", async (ctx) => {
    ctx.session.step = "idle";
    delete ctx.session.adminFlow;
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.customSyncPromptMessageId;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;
    const telegramId = ctx.from?.id;

    if (telegramId) {
        const adminRole = await getUserAdminRole(BigInt(telegramId));

        if (adminRole) {
            await ctx.answerCallbackQuery("Дію скасовано ❌");

            if (ctx.chat?.type !== "private") {
                await ctx.deleteMessage().catch(() => { });
                return;
            }

            await showAdminCancelHome(ctx, adminRole);
            return;
        }

        const { userRepository } = await import("../repositories/user-repository.js");
        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));

        if (user?.staffProfile?.isActive) {
            await ctx.answerCallbackQuery();
            const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
            await showStaffHub(ctx, false);
            return;
        }
    }

    await ctx.answerCallbackQuery("Дію скасовано ❌");
    await ctx.deleteMessage().catch(() => { });
});

commandHandlers.command("test_birthdays", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
    if (!ADMIN_IDS.includes(ctx.from?.id || 0)) return;
    await ctx.reply("Запускаю ручну перевірку днів народження...");
    await checkBirthdays(ctx.api as any); // bot was passed as Bot<MyContext>, ctx.api is close enough if we change service
    await ctx.reply("Перевірку завершено.");
});

commandHandlers.command("staff", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
    await ctx.reply("📸 Меню фотографа (Тестове)", {
        reply_markup: new InlineKeyboard().text("🆘 Написати в підтримку", "staff_help")
    });
});

commandHandlers.command("start", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const userId = ctx.from?.id;
    if (!userId) return;

    let shouldEnterScreening = false;

    try {
        const payload = ctx.match;
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat!.id, ctx.message.message_id).catch(() => { });
        }

        try {
            await cleanupMessages(ctx);
        } catch (e) {
            logger.warn({ err: e, userId }, "Start cleanupMessages failed");
        }

        ctx.session.step = "idle";
        delete ctx.session.adminFlow;
        delete ctx.session.taskData;
        delete ctx.session.taskCreation;
        delete ctx.session.broadcastData;
        delete ctx.session.broadcastDraft;
        delete ctx.session.manualChannelAccess;
        delete ctx.session.customSyncPromptMessageId;
        delete ctx.session.broadcastId;
        delete ctx.session.supportData?.step;
        delete ctx.session.supportData?.replyingToUserId;

        // Clear bot-blocked flag (user unblocked bot and pressed /start)
        const clearedBlockedUsers = await prisma.user.updateMany({
            where: { telegramId: BigInt(userId), botBlockedAt: { not: null } },
            data: { botBlockedAt: null }
        }).catch(() => ({ count: 0 }));

        // 0. Handle Deep-links (Broadcast Query & Source Tracking)
        if (payload?.startsWith("bcq_")) {
            const broadcastId = parseInt(payload.replace("bcq_", ""));
            if (!isNaN(broadcastId)) {
                await broadcastService.confirmDeclineByUser(broadcastId, userId);

                await ctx.reply("🐾 Зрозуміла! Ти вказала, що маєш запитання щодо останнього повідомлення — зараз у всьому розберемось.");

                const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));
                let isStaff = false;
                if (user) {
                    isStaff = !!user.staffProfile?.isActive;
                    const { supportRepository } = await import("../repositories/support-repository.js");
                    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);
                    if (!activeTicket) {
                        ctx.session.step = "broadcast_decline_reason";
                        ctx.session.broadcastId = broadcastId;
                    }
                }

                const callback = isStaff ? "staff_help" : "contact_hr";
                const kb = new InlineKeyboard().text("💌 Написати нам", callback);
                await ctx.reply("😟 **Бачу, що у тебе виникли запитання або зауваження.**\n\nНе хвилюйся, це нормально! Будь ласка, напиши детальніше прямо сюди (або натисни кнопку ниже), і служба турботи допоможе тобі розібратися. ✨", {
                    parse_mode: "Markdown",
                    reply_markup: kb
                });
                return;
            }
        } else if (payload?.startsWith("source_")) {
            const platform = payload.replace("source_", "");
            const sourceName = platform.charAt(0).toUpperCase() + platform.slice(1);

            if (!ctx.session.candidateData) {
                ctx.session.candidateData = { source: sourceName, clickSource: sourceName } as any;
            } else {
                ctx.session.candidateData.source = sourceName;
                ctx.session.candidateData.clickSource = sourceName;
            }
            logBusinessEvent({
                event: "candidate.source.tracked",
                telegramId: userId,
                actorType: "candidate",
                actorRole: "candidate",
                result: "success",
                module: "commands",
                operation: "start",
                updateId: ctx.update.update_id,
                safeContext: { sourceName },
            });
        }

        // 1. Admin/Support Logic (Prioritize adminRole over base role)
        try {
            const userAdminRole = await getUserAdminRole(BigInt(userId));
            if (userAdminRole) {
                logBusinessEvent({
                    event: "user.start_routed",
                    telegramId: userId,
                    actorType: "admin",
                    actorRole: userAdminRole,
                    result: "success",
                    module: "commands",
                    operation: "start",
                    updateId: ctx.update.update_id,
                    safeContext: { targetHub: userAdminRole },
                });
                await updateUserCommands(ctx, "ADMIN", userAdminRole as any);

                if (userAdminRole === 'SUPER_ADMIN' || userAdminRole === 'CO_FOUNDER' || userAdminRole === 'SUPPORT' || userAdminRole === 'HR_LEAD') {
                    // HR_LEAD: the recruiter's own HR hub was removed 2026-09-03 —
                    // recruiting now happens in the web app. HR_LEAD still has
                    // admin-shell access (search, etc.) via the HR_MENU permission.
                    const text = await staffService.getAdminHeader(userAdminRole as any);
                    await ScreenManager.renderScreen(ctx, text, "admin-main", { forceNew: true, pushToStack: true });
                    return;
                }

                if (userAdminRole === 'MENTOR_LEAD') {
                    const { mentorService } = await import("../services/mentor-service.js");
                    const text = await mentorService.getHubText();
                    await ScreenManager.renderScreen(ctx, text, "mentor-hub-menu", true);
                    return;
                }
            }
        } catch (adminErr) {
            logger.error({ err: adminErr, userId }, "Failed to load admin header in /start");
        }

        const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));

        // Active staff must always land in the staff hub. A stale active candidate
        // onboarding case should never take over /start for someone already working.
        if (user?.staffProfile?.isActive) {
            logBusinessEvent({
                event: "user.start_routed",
                telegramId: userId,
                actorType: "staff",
                actorRole: "staff",
                result: "success",
                module: "commands",
                operation: "start",
                updateId: ctx.update.update_id,
                userId: user.id,
                safeContext: { targetHub: "STAFF", bypassedFirstShiftOnboarding: true },
            });
            await updateUserCommands(ctx, "STAFF");
            const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
            await showStaffHub(ctx, true);
            return;
        }

        const { firstShiftOnboardingService } = await import("../services/first-shift-onboarding-service.js");
        const onboardingCandidate = user?.candidate || await candidateRepository.findByTelegramId(userId);
        const resumedFirstShiftOnboarding = await firstShiftOnboardingService.resumeCandidateFlowFromStart(ctx.api, userId);

        if (resumedFirstShiftOnboarding) {
            await updateUserCommands(ctx, "CANDIDATE");
            logBusinessEvent({
                event: "user.start_routed",
                telegramId: userId,
                actorType: "candidate",
                actorRole: "candidate",
                result: "success",
                module: "commands",
                operation: "start",
                updateId: ctx.update.update_id,
                userId: user?.id,
                candidateId: onboardingCandidate?.id,
                stage: onboardingCandidate?.status,
                safeContext: { targetHub: "FIRST_SHIFT_ONBOARDING" },
            });
            return;
        }

        // 2. Staff Logic

        if (user?.staffProfile) {
            if (user.staffProfile.isActive) {
                logBusinessEvent({
                    event: "user.start_routed",
                    telegramId: userId,
                    actorType: "staff",
                    actorRole: "staff",
                    result: "success",
                    module: "commands",
                    operation: "start",
                    updateId: ctx.update.update_id,
                    userId: user.id,
                    safeContext: { targetHub: "STAFF" },
                });
                await updateUserCommands(ctx, "STAFF");
                const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
                await showStaffHub(ctx, true);
                return;
            } else {
                // Inactive staff — block both staff menu and candidate flow
                await ctx.reply("🔒 <b>Доступ закрито</b>\n\nТвій профіль співробітника деактивовано.\nДякуємо за час, проведений у команді PlayPhoto, та бажаємо успіхів!", { parse_mode: "HTML" });
                return;
            }
        }

        // 3. Candidate Logic
        await updateUserCommands(ctx, "CANDIDATE");
        let candidate = onboardingCandidate;

        if (candidate) {
            const { reactivateUnderageCandidateIfEligible } = await import("../services/underage-reactivation-service.js");
            const underageReactivation = await reactivateUnderageCandidateIfEligible(candidate, "start_command");
            if (underageReactivation) {
                candidate = underageReactivation.candidate;

                if (underageReactivation.mode === "RESUME_SCREENING") {
                    ctx.session.candidateData = {
                        fullName: candidate.fullName,
                        gender: candidate.gender,
                        birthDate: candidate.birthDate?.toISOString(),
                        city: candidate.city,
                        locationIds: candidate.locationId ? [candidate.locationId] : [],
                        appearance: candidate.appearance,
                        source: candidate.source,
                        clickSource: candidate.clickSource
                    } as any;
                    await startScreening(ctx);
                    return;
                }
            }

            if (candidate.status === CandidateStatus.BLOCKER && clearedBlockedUsers.count > 0) {
                logBusinessEvent({
                    event: "candidate.recovery.started",
                    telegramId: userId,
                    actorType: "candidate",
                    actorRole: "candidate",
                    result: "success",
                    module: "commands",
                    operation: "start",
                    updateId: ctx.update.update_id,
                    userId: user?.id,
                    candidateId: candidate.id,
                    stage: candidate.status,
                    safeContext: { source: "bot_unblocked_and_started" },
                });
            }
            logBusinessEvent({
                event: "user.start_routed",
                telegramId: userId,
                actorType: "candidate",
                actorRole: "candidate",
                result: "success",
                module: "commands",
                operation: "start",
                updateId: ctx.update.update_id,
                userId: user?.id,
                candidateId: candidate.id,
                stage: candidate.status,
                safeContext: { targetHub: "CANDIDATE_STATUS" },
            });
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        } else {
            logBusinessEvent({
                event: "user.start_routed",
                telegramId: userId,
                actorType: "candidate",
                actorRole: "candidate",
                result: "success",
                module: "commands",
                operation: "start",
                updateId: ctx.update.update_id,
                safeContext: { targetHub: "SCREENING" },
            });
            shouldEnterScreening = true;
        }
    } catch (e: any) {
        logger.error({ err: e, userId }, "Start command failed");
        const kb = new InlineKeyboard()
            .text("🤍 Написати в підтримку", "staff_help");
        await ctx.reply(
            "🐾 Ой! Виникла тимчасова помилка.\n\nСпробуй /start ще раз за хвилину або звернись в підтримку — ми завжди на зв'язку! ✨",
            { reply_markup: kb }
        );
        return;
    }

    if (shouldEnterScreening) {
        await startScreening(ctx);
    }
});

commandHandlers.command("ping_admin", async (ctx) => {
    await ctx.reply("Pong! 🏓 (Admin system online)");
});

commandHandlers.command("restore_access", requireRole('SUPER_ADMIN', 'CO_FOUNDER'), async (ctx) => {
    await ctx.reply("🛠 <b>Починаю відновлення доступу...</b>\n\nЦе може зайняти кілька хвилин. Я надішлю звіт по завершенню. ✨", { parse_mode: "HTML" });

    try {
        const { restoreAccessService } = await import("../services/restore-access.js");
        const summary = await restoreAccessService.restoreAllStaffAccess(ctx.api);
        logAuditEvent({
            event: "admin.restore_access.executed",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: "admin",
            result: "success",
            module: "commands",
            operation: "restore_access",
            updateId: ctx.update.update_id,
        });
        await ctx.reply(summary, { parse_mode: "HTML" });
    } catch (e: any) {
        logger.error({ err: e, telegramId: ctx.from?.id }, "Restore access command failed");
        logAuditEvent({
            event: "admin.restore_access.executed",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: "admin",
            result: "failed",
            module: "commands",
            operation: "restore_access",
            updateId: ctx.update.update_id,
            error: e,
        });
        await ctx.reply(`❌ Помилка: ${e.message}`);
    }
});

commandHandlers.command("admin", requireRole('SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'), async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    try { await ctx.deleteMessage(); } catch (e) { }
    try {
        const userAdminRole = await getUserAdminRole(BigInt(ctx.from!.id));
        await updateUserCommands(ctx, "ADMIN", userAdminRole as any);

        const text = await staffService.getAdminHeader(userAdminRole || undefined);

        await ctx.reply(text, { reply_markup: adminMenu, parse_mode: "HTML" });
        logBusinessEvent({
            event: "admin.panel.opened",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: userAdminRole || "admin",
            result: "success",
            module: "commands",
            operation: "admin",
            updateId: ctx.update.update_id,
        });
    } catch (e: any) {
        logger.error({ err: e, telegramId: ctx.from?.id }, "Admin command failed");
        logBusinessEvent({
            event: "admin.panel.opened",
            level: "error",
            telegramId: ctx.from?.id,
            actorType: "admin",
            actorRole: "admin",
            result: "failed",
            reasonCode: "ADMIN_PANEL_OPEN_FAILED",
            module: "commands",
            operation: "admin",
            updateId: ctx.update.update_id,
            error: e,
        });
        await ctx.reply(`💥 Помилка: ${e.message}`);
    }
});

// --- DIAGNOSTIC COMMANDS ---
commandHandlers.command("debug_user", requireRole('SUPER_ADMIN', 'CO_FOUNDER'), async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) return ctx.reply("Usage: /debug_user NAME or TG_ID");

    try {
        await ctx.reply(`🔍 Investigating user: <b>${query}</b>...`, { parse_mode: "HTML" });

        const { staffRepository } = await import("../repositories/staff-repository.js");
        const { candidateRepository } = await import("../repositories/candidate-repository.js");

        let user: any = null;
        if (/^\d+$/.test(query)) {
            user = await userRepository.findWithProfilesByTelegramId(BigInt(query));
        } else {
            const staff = await staffRepository.findByQuery(query);
            if (staff.length > 0) {
                const s = staff[0] as any;
                if (s.user?.telegramId) {
                    user = await userRepository.findWithProfilesByTelegramId(BigInt(s.user.telegramId));
                }
            }

            if (!user) {
                const candidates = await candidateRepository.findByQuery(query);
                if (candidates.length > 0) {
                    const c = candidates[0] as any;
                    if (c.user?.telegramId) {
                        user = await userRepository.findWithProfilesByTelegramId(BigInt(c.user.telegramId));
                    }
                }
            }
        }

        if (!user) {
            return ctx.reply(`❌ User <b>${query}</b> not found in database.`, { parse_mode: "HTML" });
        }

        let info = `👤 <b>User Data (ID: ${user.id}):</b>\n`;
        info += `• TG ID: <code>${user.telegramId}</code>\n`;
        info += `• Name: ${user.firstName} ${user.lastName}\n`;
        info += `• Role: ${user.role}\n`;
        info += `• Admin Role: ${user.adminRole || 'None'}\n\n`;

        if (user.staffProfile) {
            info += `👨‍💼 <b>Staff Profile:</b>\n`;
            info += `• Full Name: ${user.staffProfile.fullName}\n`;
            info += `• Active: ${user.staffProfile.isActive ? '✅' : '❌'}\n`;
            info += `• Location: ${user.staffProfile.location ? formatLocation(user.staffProfile.location, "listing") : 'None'}\n\n`;
        }

        if (user.candidate) {
            info += `📝 <b>Candidate Profile:</b>\n`;
            info += `• Status: ${user.candidate.status}\n`;
            info += `• Waitlisted: ${user.candidate.isWaitlisted ? '✅' : '❌'}\n`;
            info += `• Location: ${user.candidate.location ? formatLocation(user.candidate.location, "listing") : 'None'}\n`;
        }

        await ctx.reply(info, { parse_mode: "HTML" });

    } catch (e: any) {
        logger.error({ err: e, query }, "Debug user command failed");
        await ctx.reply(`💥 Error: ${e.message}`);
    }
});

commandHandlers.command("mentor", requireRole('SUPER_ADMIN', 'MENTOR_LEAD'), async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    try { await ctx.deleteMessage(); } catch (e) { }
    try {
        const userAdminRole = await getUserAdminRole(BigInt(ctx.from!.id));
        await updateUserCommands(ctx, "ADMIN", userAdminRole as any);

        const { mentorService } = await import("../services/mentor-service.js");
        const text = await mentorService.getHubText();
        await ScreenManager.renderScreen(ctx, text, "mentor-hub-menu", { forceNew: true, pushToStack: true });
    } catch (error) {
        logger.error({ err: error, telegramId: ctx.from?.id }, "Mentor command failed");
        await ctx.reply(`💥 Сталася помилка: <code>${(error as Error).message}</code>`, { parse_mode: "HTML" });
    }
});

commandHandlers.command("reset_me", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
    const callerId = ctx.from?.id || 0;
    const isAuthorized = ADMIN_IDS.includes(callerId) || CO_FOUNDER_IDS.includes(callerId) || RESET_TESTER_IDS.includes(callerId);
    if (!isAuthorized) return;

    // Parse optional ID from text (e.g. /reset_me 12345678)
    const text = ctx.message?.text || "";
    const match = text.match(/\/reset_me\s+(\d+)/);
    const targetId = match ? BigInt(match[1]!) : BigInt(callerId);

    try {
        const user = await userRepository.findWithProfilesByTelegramId(targetId);

        if (!user) {
            return await ctx.reply(`Користувача з ID ${targetId} не знайдено в базі. 🤷‍♀️`);
        }

        // 1. Delete Candidate Data
        if (user.candidate) {
            await candidateRepository.deleteRelatedData(user.candidate.id);
            logAuditEvent({
                event: "admin.user_reset.candidate_data_deleted",
                telegramId: callerId,
                actorType: "admin",
                actorRole: "admin",
                result: "success",
                module: "commands",
                operation: "reset_me",
                updateId: ctx.update.update_id,
                candidateId: user.candidate.id,
                userId: user.id,
                safeContext: { targetTelegramId: targetId.toString() },
            });
        }

        // 2. Special Case: Clear Staff Profile if it's the tester or if specifically requested for reset
        // This allows testers to return to the candidate flow despite the security shield.
        if (user.staffProfile && (RESET_TESTER_ID_BIGINTS.has(targetId) || match)) {
            const { staffRepository } = await import("../repositories/staff-repository.js");
            await staffRepository.deleteRelatedData(user.staffProfile.id);
            logAuditEvent({
                event: "admin.user_reset.staff_profile_deleted",
                telegramId: callerId,
                actorType: "admin",
                actorRole: "admin",
                result: "success",
                module: "commands",
                operation: "reset_me",
                updateId: ctx.update.update_id,
                userId: user.id,
                safeContext: {
                    staffProfileId: user.staffProfile.id,
                    targetTelegramId: targetId.toString(),
                },
            });
        }

        ctx.session.step = "idle";
        ctx.session.candidateData = {};

        await ctx.reply(`🧹 <b>Дані для ID ${targetId} повністю очищено!</b>\n\nТепер можна натиснути /start для початку з чистого листа. ✨`, { parse_mode: "HTML" });
    } catch (e: any) {
        logger.error({ err: e, targetId }, "Reset user command failed");
        logAuditEvent({
            event: "admin.user_reset.executed",
            telegramId: callerId,
            actorType: "admin",
            actorRole: "admin",
            result: "failed",
            module: "commands",
            operation: "reset_me",
            updateId: ctx.update.update_id,
            safeContext: { targetTelegramId: targetId.toString() },
            error: e,
        });
        await ctx.reply(`❌ Помилка при скиданні: ${e.message}`);
    }
});

// --- DEV TOOLS ---
commandHandlers.command("set_step", async (ctx) => {
    try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
    if (!ALLOW_DEV_COMMANDS) return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const isAdmin = ADMIN_IDS.includes(userId);
    const isCoFounder = CO_FOUNDER_IDS.includes(userId);
    const isTester = userId === 7096140693;

    if (!isAdmin && !isCoFounder && !isTester) return;

    const step = ctx.match?.trim().toUpperCase();
    if (!step) {
        return ctx.reply("Usage: /set_step STEP_NAME\nAvailable: FULL_NAME, BIRTH_DATE, PHONE, EMAIL, PASSPORT_FRONT, PASSPORT_BACK, PASSPORT_ANNEX, IBAN, INSTAGRAM, NDA, PREFS");
    }

    const STEPS: Record<string, { session: string, status?: CandidateStatus, funnel?: FunnelStep }> = {
        FULL_NAME: { session: 'ONB_FULL_NAME', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        BIRTH_DATE: { session: 'ONB_BIRTH_DATE', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        PHONE: { session: 'ONB_PHONE', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        EMAIL: { session: 'ONB_EMAIL', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        PASSPORT_FRONT: { session: 'ONB_PASSPORT_FRONT', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        PASSPORT_BACK: { session: 'ONB_PASSPORT_BACK', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        PASSPORT_ANNEX: { session: 'ONB_PASSPORT_ANNEX', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        IBAN: { session: 'ONB_IBAN', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        INSTAGRAM: { session: 'ONB_INSTAGRAM', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        NDA: { session: 'AWAITING_NDA', status: CandidateStatus.TRAINING_COMPLETED, funnel: FunnelStep.TRAINING },
        PREFS: { session: 'SELECT_PREFS', status: CandidateStatus.AWAITING_FIRST_SHIFT, funnel: FunnelStep.FIRST_SHIFT }
    };

    const target = STEPS[step];
    if (!target) {
        return ctx.reply(`❌ Invalid step. Use one of: ${Object.keys(STEPS).join(', ')}`);
    }

    // 1. Update Session
    if (!ctx.session.candidateData) {
        ctx.session.candidateData = { step: target.session, passportPhotoIds: [] } as any;
    } else {
        ctx.session.candidateData.step = target.session;
    }

    // 2. Update DB Status to allow handler to pick it up
    try {
        const candidate = await candidateRepository.findByTelegramId(Number(userId));
        if (candidate) {
            await candidateRepository.update(candidate.id, {
                status: target.status || candidate.status,
                currentStep: target.funnel || candidate.currentStep,
            } as any);

            // If we are testing final steps, allow re-triggering welcome message
            if (step === 'PREFS' || step === 'NDA' || step === 'INSTAGRAM') {
                const staff = await staffRepository.findByUserId(candidate.userId);
                if (staff) {
                    await staffRepository.update(staff.id, { isWelcomeSent: false });
                    logger.debug({ userId }, "Testing helper reset isWelcomeSent");
                }
                // Reset role to CANDIDATE so the sync filter picks it up as a "new hire"
                await userRepository.update(candidate.userId, { role: 'CANDIDATE' });
                logger.debug({ userId }, "Testing helper reset role to candidate");
            }
        }
    } catch (e) {
        logger.error({ err: e, telegramId: userId, step }, "Set step command DB update failed");
    }

    await ctx.reply(`✅ Step set to: <b>${target.session}</b>\n\nNow send any message or press /start to trigger the handler.`, { parse_mode: "HTML" });
});

commandHandlers.command("pass_test", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
    if (!ALLOW_DEV_COMMANDS) return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const isAdmin = ADMIN_IDS.includes(userId);
    const isMentor = MENTOR_IDS.includes(userId);
    const isCoFounder = CO_FOUNDER_IDS.includes(userId);
    const isTester = userId === 7096140693;

    if (!isAdmin && !isMentor && !isCoFounder && !isTester) {
        return;
    }

    const candidate = await candidateRepository.findByTelegramId(userId);
    if (!candidate) {
        return await ctx.reply("❌ Помилка: Твій акаунт не має профілю кандидата.");
    }

    const candId = candidate.id;

    await candidateRepository.update(candId, {
        testPassed: true,
        status: CandidateStatus.OFFLINE_STAGING,
        currentStep: FunnelStep.FIRST_SHIFT,
        notificationSent: false
    });

    ctx.session.candidateData = { id: candId, step: 'SELECT_STAGING_DATES' };

    const successText = `⚡️ <b>Режим розробника: Тест пропущено</b>\n\n` +
        `Наступний крок — <b>офлайн-стажування</b> на локації.\n\n` +
        `Обери зручний день, щоб завітати до нас: 👇`;

    const kb = new InlineKeyboard();
    const today = new Date();
    const weekdays = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

    for (let i = 1; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const dayName = weekdays[d.getDay()];
        const dateStr = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}`;
        kb.text(`${dayName}, ${dateStr}`, `staging_date_${dateStr}`).row();
    }
    kb.text("Інші дати", "staging_no_date").row();

    await ctx.reply(successText, { parse_mode: "HTML", reply_markup: kb });
});
