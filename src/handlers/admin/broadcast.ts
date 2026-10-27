import { Composer } from "grammy";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { broadcastComposeHandlers, startStatelessBroadcast } from "./broadcast-compose.js";

// Бот только создаёт и отправляет рассылку (Кому → Ответ → Сообщение → Предпросмотр, см. broadcast-compose.ts).
// Всё, что после отправки (ход ответов, Remind, Withdraw, история), живёт в вебаппе.
export { startStatelessBroadcast, handleBroadcastContent, renderCitySelection } from "./broadcast-compose.js";

export const adminBroadcastHandlers = new Composer<MyContext>();
adminBroadcastHandlers.use(broadcastComposeHandlers);

/** Заголовок экрана хаба; тот же текст у кнопки в System Settings и у возврата из создания. */
export const BROADCAST_HUB_TITLE = ADMIN_TEXTS["admin-sys-broadcast"];

export const adminBroadcastHubMenu = new Menu<MyContext>("admin-broadcast-hub");

adminBroadcastHandlers.callbackQuery("br_to_hub", async (ctx) => {
    await ScreenManager.goBack(ctx, BROADCAST_HUB_TITLE, "admin-broadcast-hub");
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHubMenu.dynamic(async (_ctx, range) => {
    range.text("New announcement", async (ctx) => {
        await startStatelessBroadcast(ctx);
    }).row();
    range.text("Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "🛠️ <b>System Settings</b>", "admin-system");
    });
});

// Кнопки со старых сообщений (список Active, архив, статистика, Withdraw, Stop all pings):
// экранов больше нет, отвечаем тихо и ничего не делаем.
adminBroadcastHandlers.callbackQuery(
    /^(?:br_withdraw_(?:exec|cancel)_\d+|br_stop_all_pings_(?:exec|cancel)|br_back_to_main|admin-broadcast-(?:list|archive|manage)\/.*)$/,
    async (ctx) => {
        await ctx.answerCallbackQuery({ text: "This screen is no longer available." }).catch(() => { });
    },
);
