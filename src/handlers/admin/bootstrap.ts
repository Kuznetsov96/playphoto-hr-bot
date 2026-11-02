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
        adminTeamLocMenu, adminLocationStaffMenu, adminBirthdayMenu
    } = await import("./team.js");

    const { 
        adminFinanceMenu, adminStatementFopMenu 
    } = await import("./finance.js");

    const { 
        adminSystemMenu
    } = await import("./system.js");

    const { 
        adminStatsMenu, adminStatsCityMenu 
    } = await import("./stats.js");

    const {
        adminLogisticsMenu
    } = await import("./logistics.js");

    // 2. Register all menus in the Bot (CRITICAL for grammy/menu)
    bot.use(adminMenu);
    bot.use(adminTeamOpsMenu);
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
    

    
    bot.use(adminStatsMenu);
    bot.use(adminStatsCityMenu);
    bot.use(adminLogisticsMenu);

    // 3. Register in Registry (CRITICAL for ScreenManager.goBack and deep links)
    menuRegistry.register(adminMenu);
    menuRegistry.register(adminTeamOpsMenu);
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
    
    
    
    menuRegistry.register(adminStatsMenu);
    menuRegistry.register(adminStatsCityMenu);
    menuRegistry.register(adminLogisticsMenu);

    // 4. Build the hierarchy (Sub-menus)
    adminMenu.register(adminTeamOpsMenu);
    adminTeamOpsMenu.register(adminBirthdayMenu);
    adminTeamOpsMenu.register(adminScheduleDateMenu);
    adminScheduleDateMenu.register(adminScheduleHistoryMenu);
    adminTeamOpsMenu.register(adminScheduleCityMenu);
    adminTeamOpsMenu.register(adminScheduleLocMenu);
    adminTeamOpsMenu.register(adminScheduleStaffMenu);
    adminTeamOpsMenu.register(adminTeamCityMenu);
    adminTeamCityMenu.register(adminTeamLocMenu);
    adminTeamLocMenu.register(adminLocationStaffMenu);

    adminMenu.register(adminFinanceMenu);
    adminFinanceMenu.register(adminStatementFopMenu);
    
    adminMenu.register(adminSystemMenu);
    
    adminMenu.register(adminStatsMenu);
    adminStatsMenu.register(adminStatsCityMenu);
    adminMenu.register(adminLogisticsMenu);
}
