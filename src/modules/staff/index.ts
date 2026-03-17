import { Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { staffHandlers } from "./handlers/menu.js";
import { staffSupportHandlers, handleStaffMessage } from "./handlers/support.js";
import { handlePreferenceComment } from "../../handlers/preferences-flow.js";
import { bot } from "../../core/bot.js";

export const staffModule = new Composer<MyContext>();

// 1. Register Staff Menu and features
staffModule.use(staffHandlers);

// 2. Register Staff Support callbacks
staffModule.use(staffSupportHandlers);

// 3. Handle Messages (Support Flow for Staff)
staffModule.on("message", async (ctx, next) => {
    // A. Check for Preference Flow Comment first
    if (await handlePreferenceComment(ctx)) return;

    // B. Attempt to handle as staff support message
    const handled = await handleStaffMessage(ctx, bot);
    if (handled) return;

    // Continue if not handled
    await next();
});
// Stray Message Handler (Last resort for staff)
staffModule.on("message", async (ctx) => {
    // Only handle if not in a specific step
    const isIdle = !ctx.session.step || ctx.session.step === "idle";

    if (isIdle) {
        const { ScreenManager } = await import("../../utils/screen-manager.js");
        await ScreenManager.showUnknownCommand(ctx);
    }
});
