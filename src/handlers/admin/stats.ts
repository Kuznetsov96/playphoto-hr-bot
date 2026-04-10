import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu, MenuRange } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { statsService } from "../../services/stats-service.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { formatLocationName, normalizeCity } from "./utils.js";

export const adminStatsMenu = new Menu<MyContext>("admin-stats");

function formatStatsLocationButton(name: string, city: string): string {
    const formatted = formatLocationName(name, city);
    const citySuffix = ` (${normalizeCity(city)})`;
    return formatted.endsWith(citySuffix)
        ? formatted.slice(0, -citySuffix.length).trim()
        : formatted;
}

adminStatsMenu.dynamic(async (ctx, range: MenuRange<MyContext>) => {
    const isAllSelected = !ctx.session.broadcastCity;
    const cityLabel = ctx.session.broadcastCity ? normalizeCity(ctx.session.broadcastCity) : "All Cities";
    range.text(isAllSelected ? "🌍 🔘 All Cities" : `📍 ${cityLabel}`, async (ctx) => {
        await ctx.answerCallbackQuery("Use Change City to adjust this filter");
    });

    range.text("🏙️ Change City", async (ctx) => {
        await ctx.answerCallbackQuery();
        await ScreenManager.renderScreen(ctx, "🏙️ <b>Select Stats City</b>", "admin-stats-city");
    }).row();

    range.text("🔎 Loss Drilldown", async (ctx) => {
        ctx.session.statsView = ctx.session.statsView === "losses" ? "overview" : "losses";
        await refreshStats(ctx);
    }).row();

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
                const locLabel = formatStatsLocationButton(loc.name, loc.city);
                range.text(isSelected ? `🔘 ${locLabel}` : locLabel, async (ctx) => {
                    ctx.session.broadcastLocationId = loc.id;
                    ctx.session.broadcastLocationName = locLabel;
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

    const text = ctx.session.statsView === "losses"
        ? await statsService.buildLossDrilldown(city, locationId, locationName)
        : await statsService.buildManagementDashboard(city, locationId, locationName);
    await ScreenManager.renderScreen(ctx, text, "admin-stats");
}

// Keep the old menu ID for compatibility and use it as the compact city picker.
export const adminStatsCityMenu = new Menu<MyContext>("admin-stats-city");
adminStatsCityMenu.dynamic(async (_ctx, range: MenuRange<MyContext>) => {
    const cities = await statsService.getOfficialCities();

    range.text((ctx) => !ctx.session.broadcastCity ? "🌍 🔘 All Cities" : "🌍 All Cities", async (ctx) => {
        delete ctx.session.broadcastCity;
        delete ctx.session.broadcastLocationId;
        delete ctx.session.broadcastLocationName;
        await refreshStats(ctx);
    }).row();

    let cityCount = 0;
    for (const city of cities) {
        if (cityCount > 0 && cityCount % 2 === 0) range.row();
        const label = normalizeCity(city);
        range.text((ctx) => {
            const isSelected = ctx.session.broadcastCity === city && !ctx.session.broadcastLocationId;
            return isSelected ? `🔘 ${label}` : label;
        }, async (ctx) => {
            ctx.session.broadcastCity = city;
            delete ctx.session.broadcastLocationId;
            delete ctx.session.broadcastLocationName;
            await refreshStats(ctx);
        });
        cityCount++;
    }

    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        await refreshStats(ctx);
    });
});
