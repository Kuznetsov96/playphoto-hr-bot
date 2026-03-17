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
        adminFinanceMenu, adminStatementFopMenu, adminAuditMenu, adminDdsSyncMenu 
    } = await import("./finance.js");

    const { 
        adminSystemMenu, cityAdminMenu, locationAdminMenu, selectCityForLocMenu 
    } = await import("./system.js");

    const { 
        adminOpsMenu: recruitmentOpsMenu, adminOfflineStagingMenu, adminCandidateMenu, adminNDAMenu,
        adminFirstShiftStaffMenu, adminStagingSelectLocMenu
    } = await import("./recruitment.js");

    const { hrFinalStepMenu } = await import("../../menus/hr.js");

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
    bot.use(adminAuditMenu);
    bot.use(adminDdsSyncMenu);
    
    bot.use(adminSystemMenu);
    bot.use(cityAdminMenu);
    bot.use(locationAdminMenu);
    bot.use(selectCityForLocMenu);
    
    bot.use(recruitmentOpsMenu);
    bot.use(adminOfflineStagingMenu);
    bot.use(adminCandidateMenu);
    bot.use(adminNDAMenu);
    bot.use(adminFirstShiftStaffMenu);
    bot.use(adminStagingSelectLocMenu);
    bot.use(hrFinalStepMenu);
    
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
    menuRegistry.register(adminAuditMenu);
    menuRegistry.register(adminDdsSyncMenu);
    
    menuRegistry.register(adminSystemMenu);
    menuRegistry.register(cityAdminMenu);
    menuRegistry.register(locationAdminMenu);
    menuRegistry.register(selectCityForLocMenu);
    
    menuRegistry.register(recruitmentOpsMenu);
    menuRegistry.register(adminOfflineStagingMenu);
    menuRegistry.register(adminCandidateMenu);
    menuRegistry.register(adminNDAMenu);
    menuRegistry.register(adminFirstShiftStaffMenu);
    menuRegistry.register(adminStagingSelectLocMenu);
    
    menuRegistry.register(adminBroadcastHubMenu);
    menuRegistry.register(adminBroadcastListMenu);
    menuRegistry.register(adminBroadcastArchiveMenu);
    menuRegistry.register(adminBroadcastManageMenu);
    
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

    adminMenu.register(recruitmentOpsMenu);
    recruitmentOpsMenu.register(cityAdminMenu);
    cityAdminMenu.register(locationAdminMenu);
    recruitmentOpsMenu.register(adminCandidateMenu);
    adminCandidateMenu.register(adminFirstShiftStaffMenu);
    adminCandidateMenu.register(adminStagingSelectLocMenu);
    recruitmentOpsMenu.register(adminOfflineStagingMenu);
    recruitmentOpsMenu.register(adminNDAMenu);
    recruitmentOpsMenu.register(hrFinalStepMenu);
    
    adminMenu.register(adminFinanceMenu);
    adminFinanceMenu.register(adminDdsSyncMenu);
    adminFinanceMenu.register(adminStatementFopMenu);
    adminFinanceMenu.register(adminAuditMenu);
    
    adminMenu.register(adminSystemMenu);
    adminMenu.register(adminBroadcastHubMenu);
    adminBroadcastHubMenu.register(adminBroadcastListMenu);
    adminBroadcastHubMenu.register(adminBroadcastArchiveMenu);
    adminBroadcastHubMenu.register(adminBroadcastManageMenu);
    
    adminMenu.register(adminStatsMenu);
    adminStatsMenu.register(adminStatsCityMenu);
    adminMenu.register(adminLogisticsMenu);
}
