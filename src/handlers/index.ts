import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { Composer } from "grammy";
import type { MyContext } from "../types/context.js";
import { hrHandlers } from "./hr.js";
import { adminMenu, adminHandlers } from "./admin/index.js";
import { mentorHandlers } from "./mentor.js";
import { commandHandlers } from "./commands.js";
import { bookingHandlers } from "./booking.js";
import { staffModule } from "../modules/staff/index.js";
import { candidateModule } from "../modules/candidate/index.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";
import { staffSupportHandlers, handleSupportGroupMessage } from "../modules/staff/handlers/support.js";
import { supportHandlers, handleSupportMessage } from "./support.js";
import { staffLogisticsHandlers } from "../modules/staff/handlers/logistics.js";
import { preferencesHandlers } from "./preferences-flow.js";
import { bot } from "../core/bot.js";
import { quizHandlers, startQuiz } from "./quiz-handler.js";
import { onboardingHandlers } from "./onboarding-handler.js";
import { accessHandlers } from "./access.js";
import { broadcastService } from "../services/broadcast.js";
import { extractFirstName } from "../utils/string-utils.js";
import { slotBuilderHandlers } from "./slot-builder.js";
import { leadsHandlers } from "./leads.js";
import { blockShield } from "../middleware/block-shield.js";

export const handlers = new Composer<MyContext>();

// 1. GLOBAL SHIELDS (Highest Priority)
handlers.use(blockShield);

handlers.use(async (ctx, next) => {
    // logger.info(`🔍 [DEBUG] Handlers Entry: ${ctx.update.update_id}`);
    await next();
});

// Preferences flow must be global (accessible to staff via PM and admins via stats)
handlers.use(preferencesHandlers);

// 0. Menus should be handled at root level now

// Staff Shield: Intercept old/invalid callbacks from active staff
handlers.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // If it's a known new callback or menu callback, let it pass
    if (data.startsWith("staff_") || data.startsWith("staff-") || data.startsWith("admin_") || data.startsWith("admin-") ||
        data.startsWith("hr_") || data.startsWith("hr-") ||
        data.startsWith("mentor_") || data.startsWith("mentor-") ||
        data.startsWith("tas_") || data.startsWith("task_") || data.startsWith("b_") || data.startsWith("ticket_") ||
        data.startsWith("broadcast_") || data.startsWith("pref_") || data.startsWith("onb_") ||
        data.startsWith("gender_") || data.startsWith("city_") || data.startsWith("loc_") || data.startsWith("src_") ||
        data.startsWith("close_topic_") || data.startsWith("close_ticket_") || data.startsWith("contact_hr") ||
        data.startsWith("end_support_chat") || data.startsWith("view_staff_") ||
        data.startsWith("view_candidate_") || data.startsWith("approve_") || data.startsWith("reject_") ||
        data.startsWith("parcel_") ||
        data.startsWith("confirm_") || data.startsWith("cancel_") || data.startsWith("staging_") ||
        data.includes("/")) {
        return next();
    }

    // Check if user is active staff (but NOT admin — admins have their own handlers)
    const telegramId = ctx.from?.id;
    if (telegramId) {
        const { getAdminRoleByTelegramId } = await import("../config/roles.js");
        if (getAdminRoleByTelegramId(BigInt(telegramId))) {
            // Admin user — don't intercept, let admin handlers process
            return next();
        }

        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
        if (user?.staffProfile?.isActive) {
            logger.info({ user: telegramId, data }, "🛡️ [Staff Shield] Intercepted old callback. Redirecting to hub.");
            await ctx.answerCallbackQuery("⚠️ This button is outdated. Updating menu... ✨");
            
            // Apple Style: Auto-cleanup of stale context
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Ignore if already deleted
            }

            const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
            await showStaffHub(ctx, true); // forceNew = true to ensure a fresh clean menu
            return;
        }

        // Fired staff (staffProfile exists but isActive=false): silently discard stale callbacks
        if (user?.staffProfile && !user.staffProfile.isActive) {
            logger.info({ user: telegramId, data }, "🛡️ [Staff Shield] Fired staff pressed old button, discarding.");
            await ctx.answerCallbackQuery("Твій акаунт деактивовано. Зверніться до адміністратора. 🌸").catch(() => { });
            return;
        }
    }

    await next();
});

// Leads Handler (Topics Management)
handlers.use(leadsHandlers);

// 1. Core System Handlers (High Priority: Support, HR, Admin, Mentor, Commands)
handlers.use(commandHandlers);
handlers.use(quizHandlers);
// onboardingHandlers moved to guest context for better support routing priority
handlers.use(accessHandlers); // ✅ NEW: Handle join requests & membership sync

// Handle NDA resend from Status Card
handlers.callbackQuery(/^send_nda_(.+)$/, async (ctx) => {
    const candId = ctx.match![1]!;
    await ctx.answerCallbackQuery("Відправляю NDA... 📋");
    
    const { candidateRepository } = await import("../repositories/candidate-repository.js");
    const cand = await candidateRepository.findById(candId);
    if (!cand) return;

    const firstName = extractFirstName(cand.fullName || "");
    const { NDA_LINK } = await import("../config.js");
    const { InlineKeyboard } = await import("grammy");
    
    // Update ndaSentAt to reset reminder timer if they re-request
    await candidateRepository.update(candId, { ndaSentAt: new Date() });

    await ctx.reply(
        `Ось твоє посилання на <b>Договір про нерозголошення (NDA)</b>, ${firstName}: 📋\n\n` +
        `🔗 <a href="${NDA_LINK}">Договір NDA PlayPhoto</a>\n\n` +
        `Прочитай його уважно і натисни кнопку нижче, коли будеш готова продовжувати! ✨`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("✅ Ознайомлена з NDA", `confirm_nda_${cand.id}`)
        }
    );
});

// Handle NDA confirmation
handlers.callbackQuery(/^confirm_nda_(.+)$/, async (ctx) => {
    const candId = ctx.match![1]!;
    const { candidateRepository } = await import("../repositories/candidate-repository.js");
    const { CandidateStatus } = await import("@prisma/client");
    await candidateRepository.update(candId, { 
        ndaConfirmedAt: new Date(),
        status: CandidateStatus.KNOWLEDGE_TEST
    });
    await ctx.answerCallbackQuery("Дякуємо! NDA підписано. ✅");
    await startQuiz(ctx);
});

// Global Broadcast Receipt Confirmation
handlers.callbackQuery(/^broadcast_confirm_ok_(.+)$/, async (ctx) => {
    const broadcastId = parseInt(ctx.match![1]!);
    if (isNaN(broadcastId)) return ctx.answerCallbackQuery("Invalid ID");
    await broadcastService.confirmRead(ctx, broadcastId);
    try {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        await ctx.reply(STAFF_TEXTS["broadcast-ans-success"]);
    } catch (e) { }
});

handlers.callbackQuery(/^broadcast_confirm_decline_(.+)$/, async (ctx) => {
    const broadcastId = parseInt(ctx.match![1]!);
    if (isNaN(broadcastId)) return ctx.answerCallbackQuery("Invalid ID");
    
    await broadcastService.confirmDecline(ctx, broadcastId);
    
    // Set session step to wait for reason
    ctx.session.step = "broadcast_decline_reason";
    ctx.session.broadcastId = broadcastId;

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply(STAFF_TEXTS["broadcast-ask-decline-reason"], {
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [[{ text: STAFF_TEXTS["hr-btn-cancel"], callback_data: "staff_hub_nav" }]]
        }
    });
});

// Reordered: Support handlers first to avoid Admin/HR Menu interference (greedy matches)
handlers.use(supportHandlers);
handlers.use(staffSupportHandlers); // ✅ NEW: Allow Admins to use ticket buttons (ticket_assign, etc.)

// Replaced global registration with conditional one in routing below
// handlers.use(hrHandlers);
// handlers.use(adminHandlers); 
// handlers.use(mentorHandlers);
// handlers.use(testingHandlers);

// 2. Global Group Message Handler (Admin answering in Support Chat)
handlers.on("message", async (ctx, next) => {
    // 0. Preferences comment capture
    const { handlePreferenceComment } = await import("./preferences-flow.js");
    if (await handlePreferenceComment(ctx)) return;

    // Check if it's an Admin message in Support Group
    // A. For Staff (Returns true if handled)
    const staffHandled = await handleSupportGroupMessage(ctx, bot);
    if (staffHandled) return;

    await next();
});

handlers.callbackQuery("staff_hub_nav", async (ctx) => {
    const { showStaffHub } = await import("../modules/staff/handlers/menu.js");
    await showStaffHub(ctx);
    await ctx.answerCallbackQuery();
});

// 3. Role-Based Routing (Staff vs Candidate)
handlers.use(async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return next();

    // Admin users should NOT be routed to staffModule — admin handlers above already handle them.
    // Only route non-admin staff to staffModule.
    const { getUserAdminRole } = await import("../middleware/role-check.js");
    const adminRole = await getUserAdminRole(BigInt(telegramId));
    
    if (adminRole) {
        // --- ADMIN CONTEXT ---
        const adminApp = new Composer<MyContext>();
        adminApp.use(slotBuilderHandlers);
        adminApp.use(hrHandlers);
        adminApp.use(adminHandlers);
        adminApp.use(mentorHandlers);
        
        await adminApp.middleware()(ctx, next);
        return;
    }

    // Check if user is staff
    const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));

    if (user?.staffProfile) {
        // --- STAFF CONTEXT ---
        
        // Shield: Block deactivated staff from accessing any staff features
        if (!user.staffProfile.isActive) {
            if (ctx.chat?.type === "private") {
                const text = STAFF_TEXTS["staff-deactivated-shield"];
                if (ctx.callbackQuery) {
                    await ctx.answerCallbackQuery({ text: "Access Revoked", show_alert: true });
                } else {
                    await ctx.reply(text, { parse_mode: "HTML" });
                }
            }
            return; // Block further processing for this user
        }

        const staffApp = new Composer<MyContext>();
        // Mentors who are NOT lead-mentors (not in adminRole) still need mentorHandlers
        staffApp.use(mentorHandlers); 
        staffApp.use(staffLogisticsHandlers);
        staffApp.use(staffModule);
        await staffApp.middleware()(ctx, next);
    } else {
        // --- CANDIDATE / GUEST CONTEXT ---
        const guestApp = new Composer<MyContext>();

        // 1. Support & Communication Priority
        guestApp.on("message", async (ctx, next) => {
            const handled = await handleSupportMessage(ctx);
            if (handled) return;
            await next();
        });

        // 2. Automated Funnels
        guestApp.use(onboardingHandlers);
        guestApp.use(bookingHandlers);

        // 3. Module Logic & Catch-all
        guestApp.use(candidateModule);
        
        await guestApp.middleware()(ctx, next);
    }
});
