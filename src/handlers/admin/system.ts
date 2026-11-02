import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu, MenuRange } from "@grammyjs/menu";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getCtxAdminRole } from "../../middleware/role-check.js";
import logger from "../../core/logger.js";
import { buildTasksDashboard } from "./tasks.js";
import { ScreenManager } from "../../utils/screen-manager.js";

// --- 4. SYSTEM MENU ---
export const adminSystemMenu = new Menu<MyContext>("admin-system");
adminSystemMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    const userRole = await getCtxAdminRole(ctx);

    const hasExtendedAccess = userRole === 'SUPER_ADMIN' || userRole === 'CO_FOUNDER' || userRole === 'SUPPORT';

    if (hasExtendedAccess) {
        range.text(ADMIN_TEXTS["admin-sys-broadcast"], async (ctx: MyContext) => {
            const { startStatelessBroadcast } = await import("./broadcast-compose.js");
            await startStatelessBroadcast(ctx);
        }).row();

        range.text(ADMIN_TEXTS["admin-sys-tasks"], async (ctx: MyContext) => {
            try {
                await ctx.answerCallbackQuery().catch(() => { });
                const today = new Date().toISOString().split("T")[0] || "";
                const { text, keyboard } = await buildTasksDashboard(today, 0);
                await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
            } catch (error: any) {
                logger.error(`[ADMIN] Error in Tasks Dashboard button: ${error.message}`);
                await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-sys-err-tasks"]({ error: error.message }), new InlineKeyboard().text("Back", "admin_system_back"));
            }
        }).row();

    }

    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx: MyContext) => {
        const { staffService } = await import("../../modules/staff/services/index.js");
        const userRole = await getCtxAdminRole(ctx);
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

export const LOCATION_LEVERS_IN_WEBAPP = "Candidate visibility, city and demand are edited on the location card in the webapp.";

export const adminSystemHandlers = new Composer<MyContext>();

// Кнопки зі старих екранів локації: правки тут більше немає.
adminSystemHandlers.callbackQuery(/^toggle_visibility_(.+)$/, async (ctx: MyContext) => {
    await ctx.answerCallbackQuery({ text: LOCATION_LEVERS_IN_WEBAPP, show_alert: true }).catch(() => { });
});

adminSystemHandlers.callbackQuery(/^edit_city_(.+)$/, async (ctx: MyContext) => {
    await ctx.answerCallbackQuery({ text: LOCATION_LEVERS_IN_WEBAPP, show_alert: true }).catch(() => { });
});


// Кнопки со старых сообщений: управление локациями (admin-cities, admin-locations,
// admin-select-city-for-loc), Channel (admin-channel) и Count Magnets убраны.
// Отвечаем тихо и ничего не делаем.
adminSystemHandlers.callbackQuery(
    /^(?:admin-(?:cities|locations|select-city-for-loc|channel)\/.*|admin_magnet_counter_(?:start|confirm|correct))$/,
    async (ctx: MyContext) => {
        await ctx.answerCallbackQuery({ text: "This screen is no longer available." }).catch(() => { });
    },
);
