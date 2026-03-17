import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu, MenuRange } from "@grammyjs/menu";
import { InlineKeyboard, Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasPermission } from "../../config/roles.js";
import logger from "../../core/logger.js";
import { userRepository } from "../../repositories/user-repository.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { formatLocationName, normalizeCity } from "./utils.js";
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

    if (hasExtendedAccess) {
        range.text(ADMIN_TEXTS["admin-sys-broadcast"], async (ctx: MyContext) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-sys-broadcast"], "admin-broadcast-hub", { pushToStack: true });
        }).row();

        range.text(ADMIN_TEXTS["admin-sys-tasks"], async (ctx: MyContext) => {
            try {
                await ctx.answerCallbackQuery();
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
        await ScreenManager.goBack(ctx, "🛠️ HR Operations", "admin-ops");
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
        const displayName = formatLocationName(l.name, city);

        range.text(`${visibilityIcon} ${displayName} ${status}`, async (ctx: MyContext) => {
            await renderLocationDetails(ctx, l, city);
        }).row();
    });
    range.text(ADMIN_TEXTS["admin-ops-back"], async (ctx: MyContext) => {
        await ScreenManager.goBack(ctx, "🏙️ Select City:", "admin-cities");
    });
});

async function renderLocationDetails(ctx: MyContext, l: any, city: string) {
    const displayName = formatLocationName(l.name, city);
    const kb = new InlineKeyboard()
        .text(l.isHiddenFromCandidates ? '🔓 Show to Candidates' : '🔒 Hide from Candidates', `toggle_visibility_${l.id}`).row()
        .text("🏙️ Change City", `edit_city_${l.id}`);
    
    const text = `<b>Location:</b> ${displayName}\n` +
                 `<b>City:</b> ${l.city}\n` +
                 `<b>Current Need:</b> ${l.neededCount}\n` +
                 `───────────────────\n` +
                 `<b>Candidate Status:</b> ${l.isHiddenFromCandidates ? 'Hidden (🔒)' : 'Visible (🔓)'}\n\n` +
                 `<i>To change need, write a number.</i>\n` +
                 `<i>To change city or visibility, use buttons:</i>`;

    await ScreenManager.renderScreen(ctx, text, kb);
    ctx.session.step = `set_needed_${l.id}`;
}

// --- CITY SELECTION FOR UPDATE ---
export const selectCityForLocMenu = new Menu<MyContext>("admin-select-city-for-loc");
selectCityForLocMenu.dynamic(async (ctx: MyContext, range: MenuRange<MyContext>) => {
    const cities = await locationRepository.findAllCities(false);
    const locId = ctx.session.selectedLocationId;
    if (!locId) return;

    cities.forEach((city: string) => {
        range.text(normalizeCity(city), async (ctx: MyContext) => {
            await locationRepository.update(locId, { city });
            await ctx.answerCallbackQuery(`City changed to ${normalizeCity(city)} ✅`);
            
            // Return to city list (most logical after changing location ownership)
            await ScreenManager.goBack(ctx, "🏙️ Select City:", "admin-cities");
        }).row();
    });

    range.text("⬅️ Back", async (ctx: MyContext) => {
        await ScreenManager.goBack(ctx, "Location details", "admin-locations");
    });
});

export const adminSystemHandlers = new Composer<MyContext>();

adminSystemHandlers.callbackQuery(/^toggle_visibility_(.+)$/, async (ctx: MyContext) => {
    const locId = ctx.match?.[1];
    if (!locId) return;
    const loc = await locationRepository.findById(locId);
    if (!loc) return ctx.answerCallbackQuery("Location not found");

    const newHidden = !loc.isHiddenFromCandidates;
    // Update ONLY isHiddenFromCandidates. The rest of the system is unaffected.
    const updatedLoc = await locationRepository.update(locId, { isHiddenFromCandidates: newHidden });
    
    await ctx.answerCallbackQuery(newHidden ? "Location HIDDEN for candidates 🔒" : "Location VISIBLE for candidates 🔓");
    
    // Re-render screen to update UI
    if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
    const city = ctx.session.candidateData.city || updatedLoc.city;
    await renderLocationDetails(ctx, updatedLoc, city);
});

adminSystemHandlers.callbackQuery(/^edit_city_(.+)$/, async (ctx: MyContext) => {
    const locId = ctx.match?.[1];
    if (!locId) return;
    
    await ctx.answerCallbackQuery();
    ctx.session.selectedLocationId = locId; // Store ID for menu context
    ctx.session.step = `edit_city_${locId}`;
    
    await ScreenManager.renderScreen(
        ctx, 
        "🏙️ <b>Select new city or type a new name:</b>\n\n<i>(Type name to create new city or pick from list)</i>", 
        "admin-select-city-for-loc", 
        { pushToStack: true }
    );
});
