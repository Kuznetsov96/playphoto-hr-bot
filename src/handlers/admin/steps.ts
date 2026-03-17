import { Composer, type NextFunction } from "grammy";
import type { MyContext } from "../../types/context.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { hasAnyRole } from "../../config/roles.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { scheduleSyncService } from "../../services/schedule-sync.js";
import { createKyivDate } from "../../utils/bot-utils.js";
import logger from "../../core/logger.js";

/**
 * Logic for handling text input steps in Admin module.
 * Extracted from index.ts to improve maintainability (HIGH Priority).
 */
export const adminStepHandlers = new Composer<MyContext>();

adminStepHandlers.on("message:text", async (ctx: MyContext, next: NextFunction) => {
    const step = ctx.session?.step || "idle";

    // Filter only steps that belong to this module
    const isAdminStep =
        step.startsWith("set_needed_") ||
        step.startsWith("edit_city_") ||
        step === "sync_other_sheet" ||
        step.startsWith("set_first_shift_date_") ||
        step.startsWith("set_custom_staging_time_");

    if (!isAdminStep || step === "idle") return next();

    // 1. Permission Guard
    const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
    if (!hasAnyRole(userRole, 'SUPER_ADMIN', 'CO_FOUNDER', 'SUPPORT')) {
        await ctx.reply(ADMIN_TEXTS["admin-err-insufficient-perms"]);
        return;
    }

    // 2. Clean Chat (SMI Principle)
    await ctx.deleteMessage().catch(() => { });

    const text = ctx.message?.text || "";

    // 3. Routing by Step
    try {
        if (step.startsWith("set_needed_")) {
            return await handleSetNeeded(ctx, step, text);
        }
        if (step.startsWith("edit_city_")) {
            return await handleEditCity(ctx, step, text);
        }
        if (step.startsWith("set_first_shift_date_")) {
            return await handleSetFirstShiftDate(ctx, step, text);
        }
        if (step.startsWith("set_custom_staging_time_")) {
            return await handleSetCustomStagingTime(ctx, step, text);
        }
        if (step === "sync_other_sheet") {
            return await handleSyncOtherSheet(ctx, text);
        }
    } catch (error: any) {
        logger.error({ err: error, step, userId: ctx.from?.id }, "Error in admin step handler");
        await ScreenManager.renderScreen(ctx, `❌ Помилка: ${error.message}`, "admin-main");
        ctx.session.step = "idle";
    }

    await next();
});

// --- Individual Handlers ---

async function handleSetNeeded(ctx: MyContext, step: string, text: string) {
    const locId = step.replace("set_needed_", "");
    const count = parseInt(text.trim());
    if (isNaN(count)) return ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-prompt-number"], undefined);

    await locationRepository.update(locId, { neededCount: count });
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-success-need-updated"]({ count }), "admin-ops");
    ctx.session.step = "idle";
}

async function handleEditCity(ctx: MyContext, step: string, text: string) {
    const locId = step.replace("edit_city_", "");
    const newCity = text.trim();

    await locationRepository.update(locId, { city: newCity });
    await ctx.reply(ADMIN_TEXTS["admin-success-city-updated"]({ city: newCity }));

    ctx.session.step = "idle";
    // Повертаємось до списку міст
    await ScreenManager.renderScreen(ctx, "🏢 <b>Select City:</b>", "admin-cities", { forceNew: true });
}

async function handleSetFirstShiftDate(ctx: MyContext, step: string, text: string) {
    const candId = step.replace("set_first_shift_date_", "");
    const parts = text.trim().split('.');

    if (parts.length !== 3) {
        return ScreenManager.renderScreen(ctx, "⚠️ Invalid format. Use DD.MM.YYYY (e.g. 25.02.2026)", undefined);
    }

    const [d, m, y] = parts.map(Number);
    const shiftDate = createKyivDate(y!, m! - 1, d!, 12, 0);

    if (isNaN(shiftDate.getTime())) {
        return ScreenManager.renderScreen(ctx, "⚠️ Failed to parse date.", undefined);
    }

    // Auto-set default time if not already set
    const currentCand = await candidateRepository.findById(candId);
    const updateData: any = { firstShiftDate: shiftDate };
    if (!currentCand?.firstShiftTime) {
        updateData.firstShiftTime = "15:00-17:00";
    }
    await candidateRepository.update(candId, updateData);
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-success-date-saved"]({ date: shiftDate.toLocaleDateString('uk-UA') }), "admin-ops");
    ctx.session.step = "idle";
}

async function handleSetCustomStagingTime(ctx: MyContext, step: string, text: string) {
    const candId = step.replace("set_custom_staging_time_", "");
    const stagingTime = text.trim();

    ctx.session.stagingTime = stagingTime;
    await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-success-time-updated"]({ time: stagingTime }), "admin-candidate");
    ctx.session.step = "idle";
}

async function handleSyncOtherSheet(ctx: MyContext, text: string) {
    const sheetName = text.trim();
    try {
        const schedRes = await scheduleSyncService.syncSchedule(sheetName);
        await ScreenManager.renderScreen(ctx, `✅ Sync for "${sheetName}" complete!\n\nProcessed shifts: <b>${schedRes.count || 0}</b>`, "admin-system");
    } catch (e: any) {
        logger.error({ err: e, sheetName }, "❌ [SYNC] Custom sync failed:");
        await ScreenManager.renderScreen(ctx, `❌ Error: ${e.message}`, "admin-system");
    }
    ctx.session.step = "idle";
}
