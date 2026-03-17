import { Bot, Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { ADMIN_IDS, MENTOR_IDS, CO_FOUNDER_IDS } from "../config.js";
import { hrHubMenu } from "../menus/hr.js";
import { mentorHubMenu } from "../menus/mentor.js";
import { adminMenu } from "./admin/index.js";
import { cleanupMessages, trackMessage } from "../utils/cleanup.js";
import { checkBirthdays } from "../services/birthday-service.js";
import { userRepository } from "../repositories/user-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { staffService } from "../modules/staff/services/index.js";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { requireRole, getUserAdminRole } from "../middleware/role-check.js";
import { updateUserCommands } from "../utils/command-manager.js";
import { startScreening } from "../modules/candidate/handlers/index.js";
import { ScreenManager } from "../utils/screen-manager.js";
import logger from "../core/logger.js";

import { accessService } from "../services/access-service.js";

export const commandHandlers = new Composer<MyContext>();

// --- GLOBAL CALLBACKS ---
commandHandlers.callbackQuery("cancel_step", async (ctx) => {
    ctx.session.step = "idle";
    const telegramId = ctx.from?.id;
    
    if (telegramId) {
        const { getAdminRoleByTelegramId } = await import("../config/roles.js");
        const adminRole = getAdminRoleByTelegramId(BigInt(telegramId));

        if (adminRole) {
            await ctx.answerCallbackQuery();
            const { hrService } = await import("../services/hr-service.js");
            const { hrHubMenu } = await import("../menus/hr.js");
            const text = await hrService.getHubText();
            await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: hrHubMenu }).catch(async () => {
                await ctx.reply(text, { parse_mode: "HTML", reply_markup: hrHubMenu });
            });
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
    await ctx.reply("🎂 Running manual birthday check...");
    await checkBirthdays(ctx.api as any); // bot was passed as Bot<MyContext>, ctx.api is close enough if we change service
    await ctx.reply("✅ Check completed.");
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
            logger.warn(`[Start Debug] cleanupMessages failed: ${e}`);
        }

        ctx.session.step = "idle";

        // 0. Handle Deep-links (Broadcast Query & Source Tracking)
        if (payload?.startsWith("bcq_")) {
            const broadcastId = parseInt(payload.replace("bcq_", ""));
            if (!isNaN(broadcastId)) {
                await ctx.reply("🐾 Зрозуміла! Ти вказала, що маєш запитання щодо останнього повідомлення — зараз у всьому розберемось.");

                const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));
                let isStaff = false;
                if (user) {
                    isStaff = !!user.staffProfile?.isActive;
                    const { supportRepository } = await import("../repositories/support-repository.js");
                    const activeTicket = await supportRepository.findActiveTicketByUser(user.id);
                    if (!activeTicket) {
                        ctx.session.step = "create_ticket";
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
            logger.info({ userId, sourceName }, "📍 Candidate source tracked via deep-link");
        }

        // 1. Admin/Support Logic (Prioritize adminRole over base role)
        try {
            const userAdminRole = await getUserAdminRole(BigInt(userId));
            if (userAdminRole) {
                await updateUserCommands(ctx, "ADMIN", userAdminRole as any);
                
                if (userAdminRole === 'SUPER_ADMIN' || userAdminRole === 'CO_FOUNDER' || userAdminRole === 'SUPPORT') {
                    const text = await staffService.getAdminHeader(userAdminRole as any);
                    await ScreenManager.renderScreen(ctx, text, "admin-main", { forceNew: true, pushToStack: true });
                    return;
                }

                if (userAdminRole === 'HR_LEAD') {
                    const { hrService } = await import("../services/hr-service.js");
                    const text = await hrService.getHubText();
                    await ScreenManager.renderScreen(ctx, text, "hr-hub-menu", true);
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

        // 2. Staff Logic
        const user = await userRepository.findWithProfilesByTelegramId(BigInt(userId));
        
        if (user?.staffProfile) {
            if (user.staffProfile.isActive) {
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
        const candidate = user?.candidate || await candidateRepository.findByTelegramId(userId);

        if (candidate) {
            const { showCandidateStatus } = await import("../utils/candidate-ui.js");
            await showCandidateStatus(ctx, candidate);
            return;
        } else {
            shouldEnterScreening = true;
        }
    } catch (e: any) {
        logger.error({ err: e, userId }, "❌ Error in /start command");
        const kb = new InlineKeyboard()
            .text("🤍 Написати в підтримку", "staff_help");
        await ctx.reply(
            "🐾 Ой! Виникла тимчасова помилка.\n\nСпробуй /start ще раз за хвилину або звернись в підтримку — ми завжди на зв'язку! ✨",
            { reply_markup: kb }
        );
        return;
    }

    if (shouldEnterScreening) {
        logger.info(`[Start Debug] Entering stateless screening for ${userId}`);
        await startScreening(ctx);
    }
});

commandHandlers.command("hr", requireRole('SUPER_ADMIN', 'HR_LEAD'), async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    try { await ctx.deleteMessage(); } catch (e) { }
    const userAdminRole = await getUserAdminRole(BigInt(ctx.from!.id));
    await updateUserCommands(ctx, "ADMIN", userAdminRole as any);

    const { hrService } = await import("../services/hr-service.js");
    const text = await hrService.getHubText();
    await ScreenManager.renderScreen(ctx, text, "hr-hub-menu", { forceNew: true, pushToStack: true });
});

commandHandlers.command("ping_admin", async (ctx) => {
    await ctx.reply("Pong! 🏓 (Admin system online)");
});

commandHandlers.command("restore_access", requireRole('SUPER_ADMIN', 'CO_FOUNDER'), async (ctx) => {
    await ctx.reply("🛠 <b>Починаю відновлення доступу...</b>\n\nЦе може зайняти кілька хвилин. Я надішлю звіт по завершенню. ✨", { parse_mode: "HTML" });
    
    try {
        const { restoreAccessService } = await import("../services/restore-access.js");
        const summary = await restoreAccessService.restoreAllStaffAccess(ctx.api);
        await ctx.reply(summary, { parse_mode: "HTML" });
    } catch (e: any) {
        logger.error({ err: e }, "Error in /restore_access command");
        await ctx.reply(`❌ Помилка: ${e.message}`);
    }
});

commandHandlers.command("admin", requireRole('SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT'), async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    try { await ctx.deleteMessage(); } catch (e) { }
    logger.info(`[Debug] /admin command executing for ${ctx.from?.id}`);
    try {
        const userAdminRole = await getUserAdminRole(BigInt(ctx.from!.id));
        await updateUserCommands(ctx, "ADMIN", userAdminRole as any);

        const text = await staffService.getAdminHeader(userAdminRole || undefined);

        await ctx.reply(text, { reply_markup: adminMenu, parse_mode: "HTML" });
        logger.info(`[Debug] Admin panel loaded for ${ctx.from?.id}`);
    } catch (e: any) {
        logger.error({ err: e }, "Failure in /admin command");
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
            info += `• Location: ${user.staffProfile.location?.name || 'None'}\n\n`;
        }

        if (user.candidate) {
            info += `📝 <b>Candidate Profile:</b>\n`;
            info += `• Status: ${user.candidate.status}\n`;
            info += `• Waitlisted: ${user.candidate.isWaitlisted ? '✅' : '❌'}\n`;
            info += `• Location: ${user.candidate.location?.name || 'None'}\n`;
        }

        await ctx.reply(info, { parse_mode: "HTML" });

    } catch (e: any) {
        logger.error({ err: e }, "Failure in /debug_user command");
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
        logger.error({ err: error }, "failure in /mentor command");
        await ctx.reply(`💥 Сталася помилка: <code>${(error as Error).message}</code>`, { parse_mode: "HTML" });
    }
});

commandHandlers.command("reset_me", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
    const callerId = ctx.from?.id || 0;
    const isAuthorized = ADMIN_IDS.includes(callerId) || CO_FOUNDER_IDS.includes(callerId) || callerId === 7096140693;
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
            logger.info({ targetId }, "Candidate data deleted via /reset_me");
        }

        // 2. Special Case: Clear Staff Profile if it's the tester or if specifically requested for reset
        // This allows testers to return to the candidate flow despite the security shield.
        if (user.staffProfile && (targetId === 7096140693n || match)) {
            const { staffRepository } = await import("../repositories/staff-repository.js");
            await staffRepository.deleteRelatedData(user.staffProfile.id);
            logger.info({ targetId }, "Staff profile and related data deleted via /reset_me");
        }

        ctx.session.step = "idle";
        ctx.session.candidateData = {};

        await ctx.reply(`🧹 <b>Дані для ID ${targetId} повністю очищено!</b>\n\nТепер можна натиснути /start для початку з чистого листа. ✨`, { parse_mode: "HTML" });
    } catch (e: any) {
        logger.error({ err: e, targetId }, "Error in /reset_me");
        await ctx.reply(`❌ Помилка при скиданні: ${e.message}`);
    }
});

// --- DEV TOOLS ---
commandHandlers.command("set_step", async (ctx) => {
    try { await ctx.deleteMessage().catch(() => {}); } catch (e) { }
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

    const STEPS: Record<string, {session: string, status?: CandidateStatus, funnel?: FunnelStep}> = {
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
                isMentorLocked: true, // Re-lock for testing onboarding if needed
            } as any);

            // If we are testing final steps, allow re-triggering welcome message
            if (step === 'PREFS' || step === 'NDA' || step === 'INSTAGRAM') {
                const staff = await staffRepository.findByUserId(candidate.userId);
                if (staff) {
                    await staffRepository.update(staff.id, { isWelcomeSent: false });
                    logger.info({ userId }, "Reset isWelcomeSent to false for testing");
                }
                // Reset role to CANDIDATE so the sync filter picks it up as a "new hire"
                await userRepository.update(candidate.userId, { role: 'CANDIDATE' });
                logger.info({ userId }, "Reset role to CANDIDATE for testing");
            }
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to update DB in /set_step");
    }

    await ctx.reply(`✅ Step set to: <b>${target.session}</b>\n\nNow send any message or press /start to trigger the handler.`, { parse_mode: "HTML" });
});

commandHandlers.command("pass_test", async (ctx) => {
    try { await ctx.deleteMessage(); } catch (e) { }
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
