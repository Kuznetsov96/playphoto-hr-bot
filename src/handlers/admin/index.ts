import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu } from "@grammyjs/menu";
import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole, requireRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";
import logger from "../../core/logger.js";
import { staffRepository } from "../../repositories/staff-repository.js";
import { staffService } from "../../modules/staff/services/index.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { formatCandidateProfile } from "../../utils/profile-formatter.js";
import { ScreenManager } from "../../utils/screen-manager.js";

// Import handlers only (Menus will be registered via bootstrap.ts)
import { financeHandlers } from "./finance.js";
import { expenseHandlers } from "./finance-expense.js";
import { adminRecruitmentHandlers } from "./recruitment.js";
import { adminSystemHandlers } from "./system.js";
import { adminBroadcastHandlers, handleBroadcastContent } from "./broadcast.js";
import { adminSearchHandlers, startAdminStaffSearch, startAdminSearch, startAdminMessageFlow } from "./search.js";
import { adminStepHandlers } from "./steps.js";
import { taskFlowHandlers, handleTaskText, startTaskFlow } from "./task-flow.js";
import tasksHandlers from "./tasks.js";
import taskCreationHandlers from "./task-creation.js";
import { adminTeamHandlers } from "./team.js";
import { adminLogisticsHandlers } from "./logistics.js";

export { startAdminStaffSearch, startAdminSearch, startAdminMessageFlow };

// --- MAIN MENU CORE ---
export const adminMenu = new Menu<MyContext>("admin-main");
adminMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    let userRole: any = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
    }

    logger.info({ userId: telegramId, userRole }, "🔍 [ADMIN] Rendering main menu");

    if (hasPermission(userRole, 'STAFF_SCHEDULE')) {
        range.text(ADMIN_TEXTS["admin-main-team"], async (ctx) => {
            logger.info({ userId: ctx.from?.id }, "🔘 [ADMIN] Team button pressed");
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-main-team"], "admin-team-ops", { pushToStack: true });
        });
    }

    if (hasPermission(userRole as any, 'HR_MENU')) {
        range.text(ADMIN_TEXTS["admin-main-hr"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-main-hr"], "admin-ops", { pushToStack: true });
        });
    }
    range.row();

    if (hasPermission(userRole as any, 'FINANCE_AUDIT')) {
        range.text(ADMIN_TEXTS["admin-main-finance"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-main-finance"], "admin-finance", { pushToStack: true });
        });
    }
    
    if (hasPermission(userRole as any, 'SUPPORT_CHAT')) {
        range.text(ADMIN_TEXTS["admin-main-system"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-main-system"], "admin-system", { pushToStack: true });
        });
    }

    if (hasPermission(userRole as any, 'LOGISTICS_MENU')) {
        range.text("📦 Logistics", async (ctx) => {
            await ScreenManager.renderScreen(ctx, "📦 <b>Logistics Management</b>", "admin-logistics", { pushToStack: true });
        });
    }
    range.row();
});

export const adminHandlers = new Composer<MyContext>();

// 1. Step handlers
adminHandlers.use(adminStepHandlers);

// 2. Sub-module handlers
adminHandlers.use(adminSearchHandlers);
adminHandlers.use(expenseHandlers);
adminHandlers.use(financeHandlers);
adminHandlers.use(adminBroadcastHandlers);
adminHandlers.use(taskFlowHandlers);
adminHandlers.use(tasksHandlers);
adminHandlers.use(taskCreationHandlers);
adminHandlers.use(adminRecruitmentHandlers);
adminHandlers.use(adminSystemHandlers);
adminHandlers.use(adminTeamHandlers);
adminHandlers.use(adminLogisticsHandlers);

adminHandlers.on(["message:text", "message:photo", "message:video"], async (ctx, next) => {
    if (ctx.chat?.type !== "private") return await next();
    
    if (ctx.session.supportData?.step === 'AWAITING_REPLY' && ctx.session.supportData?.replyingToUserId) {
        const targetId = Number(ctx.session.supportData.replyingToUserId);
        const replyText = ctx.message?.text || ctx.message?.caption || "";
        
        await ctx.deleteMessage().catch(() => {});

        try {
            const { InlineKeyboard } = await import("grammy");
            const replyKb = new InlineKeyboard().text("💬 Відповісти", "contact_hr");

            await ctx.api.sendMessage(targetId, `📩 <b>Повідомлення від PlayPhoto:</b>\n\n${replyText}`, { 
                parse_mode: "HTML",
                reply_markup: replyKb
            });
            await ScreenManager.renderScreen(ctx, "✅ Your reply has been sent to the candidate.", "admin-main");
            
            const { userRepository } = await import("../../repositories/user-repository.js");
            const user = await userRepository.findByTelegramId(BigInt(targetId));
            if (user) {
                const { timelineRepository } = await import("../../repositories/timeline-repository.js");
                await timelineRepository.createEvent(user.id, 'MESSAGE', 'ADMIN', `[Direct Reply] ${replyText}`, { adminId: ctx.from?.id });
            }
        } catch (e: any) {
            await ScreenManager.renderScreen(ctx, `❌ Send Error: ${e.message}`, "admin-main");
        }
        
        delete ctx.session.supportData.step;
        delete ctx.session.supportData.replyingToUserId;
        return;
    }

    if (await handleBroadcastContent(ctx)) return;
    if (await handleTaskText(ctx)) return;
    await next();
});

const adminProtected = new Composer<MyContext>();
const protectedAdminCallbacks = adminProtected.filter(c => c.has("callback_query:data") && (
    c.callbackQuery.data.startsWith("admin_") || 
    c.callbackQuery.data.startsWith("admin-") || 
    c.callbackQuery.data.startsWith("b_") || 
    c.callbackQuery.data.startsWith("view_") || 
    c.callbackQuery.data.startsWith("close_topic_") || 
    c.callbackQuery.data.startsWith("forward_to_kuznetsov_") ||
    c.callbackQuery.data.startsWith("back_to_") ||
    c.callbackQuery.data.startsWith("ticket_") ||
    c.callbackQuery.data.startsWith("pref_") ||
    c.callbackQuery.data.startsWith("task_") ||
    c.callbackQuery.data.startsWith("tas_")
));
protectedAdminCallbacks.use(requireRole('SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT', 'HR_LEAD', 'MENTOR_LEAD'));

protectedAdminCallbacks.callbackQuery("admin_main_back", async (ctx: MyContext) => {
    const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
    const text = await staffService.getAdminHeader(userRole as any);
    await ScreenManager.goBack(ctx, text, "admin-main");
    await ctx.answerCallbackQuery();
});

protectedAdminCallbacks.callbackQuery("admin_main_menu", async (ctx: MyContext) => {
    // Clear flow-specific data
    delete ctx.session.adminFlow;
    delete ctx.session.selectedDate;
    delete ctx.session.selectedLocationId;
    delete ctx.session.taskData;
    delete ctx.session.broadcastData;
    ctx.session.candidateData = {};

    const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
    const text = await staffService.getAdminHeader(userRole as any);
    await ScreenManager.renderScreen(ctx, text, "admin-main", { forceNew: true });
    await ctx.answerCallbackQuery();
});

protectedAdminCallbacks.callbackQuery("admin_back_to_cities", async (ctx: MyContext) => {
    const flow = ctx.session.adminFlow;

    // 1. Schedule Flow (Highest priority if we came from Schedule)
    if (flow === 'SCHEDULE' && ctx.session.selectedDate) {
        const date = new Date(ctx.session.selectedDate);
        const dateStr = date.toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
        await ScreenManager.renderScreen(ctx, `🏢 <b>Select City (${dateStr}):</b>`, "admin-schedule-cities", { forceNew: true });
        await ctx.answerCallbackQuery();
        return;
    }

    // 2. Broadcast Flow (Active process)
    if (flow === 'BROADCAST' && ctx.session.broadcastData) {
        const { renderCitySelection } = await import("./broadcast.js");
        await renderCitySelection(ctx);
        await ctx.answerCallbackQuery();
        return;
    }

    // 3. Task Flow (Active process)
    if (flow === 'TASK') {
        // If task was finished, go to generic city selection for locations
        await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-team-cities", { forceNew: true });
        await ctx.answerCallbackQuery();
        return;
    }

    // 4. Default: Main Team Cities (for LOCATIONS, SEARCH, or finished flows)
    await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-team-cities", { forceNew: true });
    await ctx.answerCallbackQuery();
});

protectedAdminCallbacks.callbackQuery("admin_system_back", async (ctx: MyContext) => {
    const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
    const text = await staffService.getAdminHeader(userRole as any);
    await ScreenManager.goBack(ctx, text, "admin-system");
    await ctx.answerCallbackQuery();
});

protectedAdminCallbacks.callbackQuery(/^admin_send_(msg|task)_(.+)$/, async (ctx: MyContext) => {
    await ctx.answerCallbackQuery();
    const type = ctx.match![1]!;
    const userId = ctx.match![2]!;
    if (type === "msg") {
        await startAdminMessageFlow(ctx, userId);
    } else {
        await startTaskFlow(ctx, userId);
    }
});

adminHandlers.use(adminProtected);

protectedAdminCallbacks.callbackQuery(/^view_staff_(.+)$/, async (ctx) => {
    const staffId = ctx.match![1]!;
    await ctx.answerCallbackQuery();

    const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
    const staff = await staffRepository.findById(staffId);
    if (!staff) return ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-search-staff-not-found"], "admin-main");

    ctx.session.selectedUserId = staff.userId;
    const text = (await staffService.getProfileText(staff, false, userRole as any)) + `\n${ADMIN_TEXTS["admin-profile-select-action"]}`;

    const kb = new InlineKeyboard()
        .text("💬 Write Message", `admin_send_msg_${staff.userId}`).row()
        .text("📝 Set Task", `admin_send_task_${staff.userId}`).row();

    if (userRole === "SUPER_ADMIN") {
        kb.text("📋 Chat History", `admin_timeline_export_${staff.userId}`).row();
    }
    kb.text("🏠 Main Menu", "admin_main_back");

    await ScreenManager.renderScreen(ctx, text, kb, { pushToStack: true });
});

protectedAdminCallbacks.callbackQuery(/^view_candidate(_new)?_(.+)$/, async (ctx) => {
    const isNew = ctx.match![1] === "_new";
    const data = ctx.match![2]!;
    await ctx.answerCallbackQuery();

    let candidate;
    if (isNew) {
        candidate = await candidateRepository.findByTelegramId(Number(data));
    } else {
        candidate = await candidateRepository.findById(data);
    }

    if (!candidate) return ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-staging-candidate-not-found"], "admin-main");

    ctx.session.selectedCandidateId = candidate.id;

    const text = await formatCandidateProfile(ctx as any, candidate as any, {
        includeActionLabel: true,
        actionLabel: ADMIN_TEXTS["support-panel-action"]
    });

    if (candidate.tattooPhotoId) {
        await ScreenManager.renderScreen(ctx, text, "admin-candidate-details", { 
            pushToStack: true,
            photoId: candidate.tattooPhotoId 
        });
    } else {
        await ScreenManager.renderScreen(ctx, text, "admin-candidate-details", { pushToStack: true });
    }
});

protectedAdminCallbacks.callbackQuery("back_to_schedule_staff", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-main-team"], "admin-schedule-staff");
});

protectedAdminCallbacks.callbackQuery("back_to_loc_staff", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-main-team"], "admin-location-staff");
});

protectedAdminCallbacks.callbackQuery("admin_birthdays_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ScreenManager.goBack(ctx, ADMIN_TEXTS["admin-bday-header-all"] + "\n\n" + ADMIN_TEXTS["admin-bday-select-month"], "admin-birthdays");
});

protectedAdminCallbacks.callbackQuery(/^admin_timeline_export_(.+)$/, async (ctx) => {
    const { handleAdminTimelineExport } = await import("./search.js");
    await handleAdminTimelineExport(ctx, ctx.match![1]!);
});
