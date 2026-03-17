import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu, MenuRange } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { statsService } from "../../services/stats-service.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { normalizeCity } from "./utils.js";

export const adminStatsMenu = new Menu<MyContext>("admin-stats");

adminStatsMenu.dynamic(async (ctx, range: MenuRange<MyContext>) => {
    const cities = await statsService.getOfficialCities();
    
    // 1. City selection buttons (2 per row)
    const isAllSelected = !ctx.session.broadcastCity;
    range.text(isAllSelected ? "🌍 🔘 All" : "🌍 All", async (ctx) => {
        delete ctx.session.broadcastCity;
        delete ctx.session.broadcastLocationId;
        delete ctx.session.broadcastLocationName;
        await refreshStats(ctx);
    });

    let cityCount = 1;
    for (const city of cities) {
        if (cityCount % 2 === 0) range.row();
        const isSelected = ctx.session.broadcastCity === city && !ctx.session.broadcastLocationId;
        range.text(isSelected ? `🔘 ${city}` : city, async (ctx) => {
            ctx.session.broadcastCity = city;
            delete ctx.session.broadcastLocationId;
            delete ctx.session.broadcastLocationName;
            await refreshStats(ctx);
        });
        cityCount++;
    }
    range.row();

    // 2. Location selection if city is selected
    if (ctx.session.broadcastCity) {
        const locations = await statsService.getLocationsForCity(ctx.session.broadcastCity);
        if (locations.length > 0) {
            range.text(ctx.session.broadcastLocationId ? "📍 All Locations" : "📍 🔘 All Locations", async (ctx) => {
                delete ctx.session.broadcastLocationId;
                delete ctx.session.broadcastLocationName;
                await refreshStats(ctx);
            }).row();

            let locCount = 0;
            for (const loc of locations) {
                if (locCount % 2 === 0) range.row();
                const isSelected = ctx.session.broadcastLocationId === loc.id;
                range.text(isSelected ? `🔘 ${loc.name}` : loc.name, async (ctx) => {
                    ctx.session.broadcastLocationId = loc.id;
                    ctx.session.broadcastLocationName = loc.name;
                    await refreshStats(ctx);
                });
                locCount++;
            }
            range.row();
        }
    }

    range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        delete ctx.session.broadcastCity;
        delete ctx.session.broadcastLocationId;
        delete ctx.session.broadcastLocationName;
        await ScreenManager.goBack(ctx, "📅 <b>Team Operations</b>", "admin-team-ops");
    });
});

async function refreshStats(ctx: MyContext) {
    await ctx.answerCallbackQuery();
    const city = ctx.session.broadcastCity;
    const locationId = ctx.session.broadcastLocationId;
    const locationName = ctx.session.broadcastLocationName;

    const [stats, weeklyNew] = await Promise.all([
        statsService.getCandidateFunnelStats(city, locationId),
        statsService.getWeeklyNewCount(city, locationId)
    ]);
    const text = statsService.formatFunnelDashboard(stats, weeklyNew, city, locationName);
    await ScreenManager.renderScreen(ctx, text, "admin-stats");
}

// Keep the old menu ID for compatibility during bootstrap but redirect it
export const adminStatsCityMenu = new Menu<MyContext>("admin-stats-city");
adminStatsCityMenu.text("Redirecting...", async (ctx) => {
    await ScreenManager.renderScreen(ctx, "Loading stats...", "admin-stats");
});
