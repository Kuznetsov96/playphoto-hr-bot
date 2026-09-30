import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu, MenuRange } from "@grammyjs/menu";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";
import logger from "../../core/logger.js";
import { userRepository } from "../../repositories/user-repository.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { formatLocation, normalizeCity } from "./utils.js";
import { buildTasksDashboard } from "./tasks.js";
import { ScreenManager } from "../../utils/screen-manager.js";

// --- 4. SYSTEM MENU ---
export const adminSystemMenu = new Menu<MyContext>("admin-system");
adminSystemMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    const telegramId = ctx.from?.id;
    let userRole = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
    }

    const hasExtendedAccess = userRole === 'SUPER_ADMIN' || userRole === 'CO_FOUNDER' || userRole === 'SUPPORT';
    const canCountMagnets = userRole === "SUPPORT";

    if (canCountMagnets) {
        range.text("🧲 Count Magnets", async (ctx: MyContext) => {
            await ScreenManager.renderScreen(
                ctx,
                "🧲 <b>Count Magnets</b>\n\nTap the button below, then send a photo of the magnet stacks.",
                new InlineKeyboard()
                    .text("📸 Upload Photo", "admin_magnet_counter_start")
                    .row()
                    .text("⬅️ Back", "admin_system_back"),
                { pushToStack: true }
            );
        }).row();
    }

    if (hasExtendedAccess) {
        range.text(ADMIN_TEXTS["admin-sys-broadcast"], async (ctx: MyContext) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-sys-broadcast"], "admin-broadcast-hub", { pushToStack: true });
        }).row();

        range.text(ADMIN_TEXTS["admin-sys-tasks"], async (ctx: MyContext) => {
            try {
                await ctx.answerCallbackQuery().catch(() => { });
                const today = new Date().toISOString().split("T")[0] || "";
                const { text, keyboard } = await buildTasksDashboard(today, 0);
                await ScreenManager.renderScreen(ctx, text, keyboard, { pushToStack: true });
            } catch (error: any) {
                logger.error(`[ADMIN] Error in Tasks Dashboard button: ${error.message}`);
                await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-sys-err-tasks"]({ error: error.message }), new InlineKeyboard().text("⬅️ Back", "admin_system_back"));
            }
        }).row();

        range.text(ADMIN_TEXTS["admin-sys-tickets"], async (ctx: MyContext) => {
            const { showTicketsDashboard } = await import("./tickets.js");
            await showTicketsDashboard(ctx);
        }).row();
    }

    if (hasPermission(userRole as any, 'LOGISTICS_MENU')) {
        range.text("📦 Logistics", async (ctx: MyContext) => {
            await ScreenManager.renderScreen(ctx, "📦 <b>Logistics Management</b>", "admin-logistics", { pushToStack: true });
        }).row();
    }

    range.text(ADMIN_TEXTS["hr-menu-back"], async (ctx: MyContext) => {
        const { staffService } = await import("../../modules/staff/services/index.js");
        const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

// --- CITY/LOC MENUS (Attached to System/HR) ---
export const cityAdminMenu = new Menu<MyContext>("admin-cities");
cityAdminMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    const cities = await locationRepository.findAllCities(false); // including hidden for management
    cities.forEach((city: string) => {
        range.text(normalizeCity(city), async (ctx: MyContext) => {
            if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
            ctx.session.candidateData.city = city;
            await ScreenManager.renderScreen(ctx, `🏢 Locations in ${normalizeCity(city)}:`, "admin-locations", { pushToStack: true });
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-ops-back"], async (ctx: MyContext) => {
        // HR-хаб прибрано — повертаємось у меню System, звідки список міст і відкривають.
        await ScreenManager.goBack(ctx, "⚙️ <b>System</b>", "admin-system");
    });
});

export const locationAdminMenu = new Menu<MyContext>("admin-locations");
locationAdminMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
    const city = ctx.session.candidateData.city;
    if (!city) return;

    const locations = await locationRepository.findByCityAdmin(city);

    locations.forEach((l: any) => {
        const visibilityIcon = l.isHiddenFromCandidates ? "👻" : "👁️";
        const status = l.neededCount > 0 ? `🟢 (${l.neededCount})` : "🔴 (0)";
        const displayName = formatLocation({ ...l, city }, "in-city");

        range.text(`${visibilityIcon} ${displayName} ${status}`, async (ctx: MyContext) => {
            await renderLocationDetails(ctx, l, city);
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-ops-back"], async (ctx: MyContext) => {
        await ScreenManager.goBack(ctx, "🏙️ Select City:", "admin-cities");
    });
});

async function renderLocationDetails(ctx: MyContext, l: any, city: string) {
    ctx.session.adminFlow = "LOCATIONS";
    delete ctx.session.taskData;
    delete ctx.session.taskCreation;
    delete ctx.session.bulkTaskData;
    delete ctx.session.broadcastData;
    delete ctx.session.broadcastDraft;
    delete ctx.session.manualChannelAccess;
    delete ctx.session.supportData?.step;
    delete ctx.session.supportData?.replyingToUserId;

    const displayName = formatLocation({ ...l, city }, "sentence");

    // Лише перегляд. Видимість, місто й потребу задає картка локації у
    // вебаппі, а синк кожні 5 хвилин переписує їх звідти: правка тут жила до
    // наступного проходу й створювала другу, тимчасову правду.
    const text = `<b>Location:</b> ${displayName}\n` +
                 `<b>City:</b> ${l.city}\n` +
                 `<b>Current Need:</b> ${l.neededCount}\n` +
                 `───────────────────\n` +
                 `<b>Candidate Status:</b> ${l.isHiddenFromCandidates ? 'Hidden (🔒)' : 'Visible (🔓)'}\n\n` +
                 `<i>${LOCATION_LEVERS_IN_WEBAPP}</i>`;

    await ScreenManager.renderScreen(ctx, text, new InlineKeyboard());
    ctx.session.step = "idle";
}

export const LOCATION_LEVERS_IN_WEBAPP = "Видимість для кандидаток, місто й потреба змінюються в картці локації у вебаппі.";

// --- CITY SELECTION FOR UPDATE ---
export const selectCityForLocMenu = new Menu<MyContext>("admin-select-city-for-loc");
selectCityForLocMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    const cities = await locationRepository.findAllCities(false);
    const locId = ctx.session.selectedLocationId;
    if (!locId) return;

    cities.forEach((city: string) => {
        range.text(normalizeCity(city), async (ctx: MyContext) => {
            // Місто задає вебапп; меню лишилось лише для старих повідомлень.
            await ctx.answerCallbackQuery({ text: LOCATION_LEVERS_IN_WEBAPP, show_alert: true }).catch(() => { });
            if (ctx.session.adminFlow === "LOCATIONS") {
                delete ctx.session.adminFlow;
            }
            if (ctx.session.step?.startsWith("edit_city_")) {
                ctx.session.step = "idle";
            }
            
            // Return to city list (most logical after changing location ownership)
            await ScreenManager.goBack(ctx, "🏙️ Select City:", "admin-cities");
        }).row();
    });

    range.text("⬅️ Back", async (ctx: MyContext) => {
        await ScreenManager.goBack(ctx, "Location details", "admin-locations");
    });
});

export const adminSystemHandlers = new Composer<MyContext>();

// Кнопки зі старих екранів локації: правки тут більше немає.
adminSystemHandlers.callbackQuery(/^toggle_visibility_(.+)$/, async (ctx: MyContext) => {
    await ctx.answerCallbackQuery({ text: LOCATION_LEVERS_IN_WEBAPP, show_alert: true }).catch(() => { });
});

adminSystemHandlers.callbackQuery(/^edit_city_(.+)$/, async (ctx: MyContext) => {
    await ctx.answerCallbackQuery({ text: LOCATION_LEVERS_IN_WEBAPP, show_alert: true }).catch(() => { });
});

