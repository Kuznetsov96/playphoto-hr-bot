import { adminMenu } from "./index.js";
import type { MyContext } from "../../types/context.js";
import { menuRegistry } from "../../utils/menu-registry.js";

/**
 * This file exists EXCLUSIVELY to break circular dependencies.
 * It imports all sub-menus and registers them into the main adminMenu.
 */
export async function registerAdminMenusHierarchy(bot: any) {
    // 1. Dynamic imports
    const { 
        adminTeamOpsMenu, adminScheduleDateMenu, adminScheduleHistoryMenu, adminScheduleCityMenu, 
        adminScheduleLocMenu, adminScheduleStaffMenu, adminTeamCityMenu, 
        adminTeamLocMenu, adminLocationStaffMenu, adminBirthdayMenu, adminChannelMenu
    } = await import("./team.js");

    const { 
        adminFinanceMenu, adminStatementFopMenu 
    } = await import("./finance.js");

    const { 
        adminSystemMenu, cityAdminMenu, locationAdminMenu, selectCityForLocMenu 
    } = await import("./system.js");

    const { 
        adminBroadcastHubMenu, adminBroadcastListMenu, adminBroadcastArchiveMenu, adminBroadcastManageMenu 
    } = await import("./broadcast.js");

    const { 
        adminStatsMenu, adminStatsCityMenu 
    } = await import("./stats.js");

    const {
        adminLogisticsMenu
    } = await import("./logistics.js");

    // 2. Register all menus in the Bot (CRITICAL for grammy/menu)
    bot.use(adminMenu);
    bot.use(adminTeamOpsMenu);
    bot.use(adminChannelMenu);
    bot.use(adminBirthdayMenu);
    bot.use(adminScheduleDateMenu);
    bot.use(adminScheduleHistoryMenu);
    bot.use(adminScheduleCityMenu);
    bot.use(adminScheduleLocMenu);
    bot.use(adminScheduleStaffMenu);
    bot.use(adminTeamCityMenu);
    bot.use(adminTeamLocMenu);
    bot.use(adminLocationStaffMenu);
    
    bot.use(adminFinanceMenu);
    bot.use(adminStatementFopMenu);
    
    bot.use(adminSystemMenu);
    bot.use(cityAdminMenu);
    bot.use(locationAdminMenu);
    bot.use(selectCityForLocMenu);
    

    bot.use(adminBroadcastHubMenu);
    bot.use(adminBroadcastListMenu);
    bot.use(adminBroadcastArchiveMenu);
    bot.use(adminBroadcastManageMenu);
    
    bot.use(adminStatsMenu);
    bot.use(adminStatsCityMenu);
    bot.use(adminLogisticsMenu);

    // 3. Register in Registry (CRITICAL for ScreenManager.goBack and deep links)
    menuRegistry.register(adminMenu);
    menuRegistry.register(adminTeamOpsMenu);
    menuRegistry.register(adminChannelMenu);
    menuRegistry.register(adminBirthdayMenu);
    menuRegistry.register(adminScheduleDateMenu);
    menuRegistry.register(adminScheduleHistoryMenu);
    menuRegistry.register(adminScheduleCityMenu);
    menuRegistry.register(adminScheduleLocMenu);
    menuRegistry.register(adminScheduleStaffMenu);
    menuRegistry.register(adminTeamCityMenu);
    menuRegistry.register(adminTeamLocMenu);
    menuRegistry.register(adminLocationStaffMenu);

    menuRegistry.register(adminFinanceMenu);
    menuRegistry.register(adminStatementFopMenu);
    
    menuRegistry.register(adminSystemMenu);
    menuRegistry.register(cityAdminMenu);
    menuRegistry.register(locationAdminMenu);
    menuRegistry.register(selectCityForLocMenu);
    
    
    menuRegistry.register(adminBroadcastHubMenu);
    menuRegistry.register(adminBroadcastListMenu);
    menuRegistry.register(adminBroadcastArchiveMenu);
    menuRegistry.register(adminBroadcastManageMenu);
    
    menuRegistry.register(adminStatsMenu);
    menuRegistry.register(adminStatsCityMenu);
    menuRegistry.register(adminLogisticsMenu);

    // 4. Build the hierarchy (Sub-menus)
    adminMenu.register(adminTeamOpsMenu);
    adminTeamOpsMenu.register(adminChannelMenu);
    adminTeamOpsMenu.register(adminBirthdayMenu);
    adminTeamOpsMenu.register(adminScheduleDateMenu);
    adminScheduleDateMenu.register(adminScheduleHistoryMenu);
    adminTeamOpsMenu.register(adminScheduleCityMenu);
    adminTeamOpsMenu.register(adminScheduleLocMenu);
    adminTeamOpsMenu.register(adminScheduleStaffMenu);
    adminTeamOpsMenu.register(adminTeamCityMenu);
    adminTeamCityMenu.register(adminTeamLocMenu);
    adminTeamLocMenu.register(adminLocationStaffMenu);

    // HR-хаб прибрано 10.09.2026: підбір ведеться у вебзастосунку.
    // cityAdminMenu лишається — його відкриває меню System.
    cityAdminMenu.register(locationAdminMenu);

    adminMenu.register(adminFinanceMenu);
    adminFinanceMenu.register(adminStatementFopMenu);
    
    adminMenu.register(adminSystemMenu);
    adminMenu.register(adminBroadcastHubMenu);
    adminBroadcastHubMenu.register(adminBroadcastListMenu);
    adminBroadcastHubMenu.register(adminBroadcastArchiveMenu);
    adminBroadcastHubMenu.register(adminBroadcastManageMenu);
    
    adminMenu.register(adminStatsMenu);
    adminStatsMenu.register(adminStatsCityMenu);
    adminMenu.register(adminLogisticsMenu);
}
