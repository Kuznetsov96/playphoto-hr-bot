import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../types/context.js";
import { menuRegistry } from "../utils/menu-registry.js";

// --- ROOT MENU ---
export const staffRootMenu = new Menu<MyContext>("staff-root");
menuRegistry.register(staffRootMenu);

// --- MAIN HUB MENU ---
export const staffHubMenu = new Menu<MyContext>("staff-main");
menuRegistry.register(staffHubMenu);

staffHubMenu.dynamic(async (ctx, range) => {
    // 1. My Schedule
    range.text("🗓 Мій графік", async (ctx) => {
        const { showStaffSchedule } = await import("../modules/staff/handlers/menu.js");
        await showStaffSchedule(ctx);
    });

    // 2. Preferences (Schedule requests) - only visible 23rd to end of month
    const now = new Date();
    const kyivNow = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    if (kyivNow.getDate() >= 23) {
        const nextMonth = new Date(kyivNow.getFullYear(), kyivNow.getMonth() + 1, 1);
        const monthName = nextMonth.toLocaleString('uk-UA', { month: 'long' });
        range.text(`🗓 Побажання (${monthName})`, async (ctx) => {
            // Trigger the callback handler by data or call the function directly
            // Since we want to break circular dependency, we can use ctx.menu.nav if it was a submenu,
            // but this is a separate flow. We can use a dynamic import here inside the handler.
            const { startPreferencesFlow } = await import("../handlers/preferences-flow.js");
            await startPreferencesFlow(ctx);
        }).row();
    }

    // 3. Support / Care Service
    range.text("🤍 Служба турботи", async (ctx) => {
        const { startSupportFlow } = await import("../modules/staff/handlers/menu.js");
        await startSupportFlow(ctx);
    }).row();

    // 4. Tasks (Dynamic label with count from session)
    const count = ctx.session.activeTasksCount || 0;
    const taskLabel = count > 0 ? `📋 Мої завдання (${count})` : "📋 Мої завдання";

    range.text(taskLabel, async (ctx) => {
        const { showStaffTasks } = await import("../modules/staff/handlers/menu.js");
        await showStaffTasks(ctx);
    });

    // 5. Logistics (Parcels)
    const telegramId = ctx.from?.id;
    if (telegramId) {
        const { userRepository } = await import("../repositories/user-repository.js");
        const { workShiftRepository } = await import("../repositories/work-shift-repository.js");
        const prisma = (await import("../db/core.js")).default;
        
        const user = await userRepository.findWithStaffProfileByTelegramId(BigInt(telegramId));
        if (user && user.staffProfile) {
            const kyivToday = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
            kyivToday.setHours(0, 0, 0, 0);
            
            const todayShifts = await workShiftRepository.findWithLocationForStaff(user.staffProfile.id, kyivToday, 1);
            if (todayShifts.length > 0 && todayShifts[0]?.date.getTime() === kyivToday.getTime()) {
                const shift = todayShifts[0];
                const pendingParcelsCount = await prisma.parcel.count({
                    where: {
                        locationId: shift.locationId,
                        OR: [
                            { status: { in: ['EXPECTED', 'ARRIVED'] } },
                            { status: 'DELIVERED', deliveryType: 'Address', contentPhotoIds: { isEmpty: true } }
                        ]
                    }
                });
                
                const parcelLabel = pendingParcelsCount > 0 ? `📦 Посилки локації (${pendingParcelsCount})` : "📦 Посилки локації";
                range.row().text(parcelLabel, async (ctx) => {
                    const { showStaffLogistics } = await import("../modules/staff/handlers/menu.js");
                    await showStaffLogistics(ctx);
                });
            }
        }
    }
});

// --- SUBMENUS (Declared for type safety and navigation) ---
export const staffScheduleMenu = new Menu<MyContext>("staff-schedule");
menuRegistry.register(staffScheduleMenu);
export const staffTasksMenu = new Menu<MyContext>("staff-tasks");
menuRegistry.register(staffTasksMenu);
export const staffPreferencesMenu = new Menu<MyContext>("staff-preferences");
menuRegistry.register(staffPreferencesMenu);

// --- REGISTRATION ---
staffRootMenu.register(staffHubMenu);
staffHubMenu.register(staffScheduleMenu);
staffHubMenu.register(staffTasksMenu);
staffHubMenu.register(staffPreferencesMenu);
