import { Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { backToSystem, broadcastComposeHandlers } from "./broadcast-compose.js";

// Бот только создаёт и отправляет рассылку (Кому → Ответ → Сообщение → Предпросмотр, см. broadcast-compose.ts).
// Всё, что после отправки (ход ответов, Remind, Withdraw, история), живёт в вебаппе. Промежуточного
// экрана нет: «Announcements» в System сразу открывает создание, отмена и «Done» возвращают в System.
export { startStatelessBroadcast, handleBroadcastContent, renderCitySelection } from "./broadcast-compose.js";

export const adminBroadcastHandlers = new Composer<MyContext>();
adminBroadcastHandlers.use(broadcastComposeHandlers);

/** Возврат из рассылки в System; «br_to_hub» — кнопка со старых экранов успеха. */
adminBroadcastHandlers.callbackQuery(["br_done", "br_to_hub"], async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => { });
    await backToSystem(ctx);
});

// Кнопки со старых сообщений (прежний экран Announcements, список Active, архив, статистика,
// Withdraw, Stop all pings): экранов больше нет, отвечаем тихо и ничего не делаем. Сюда же старые
// шаги прежнего мастера (тип, кнопка, медиа, подтверждение, охват, перезапуск): новый поток этих
// callback data не использует.
adminBroadcastHandlers.callbackQuery(
    /^(?:br_withdraw_(?:exec|cancel)_\d+|br_stop_all_pings_(?:exec|cancel)|br_back_to_main|br_restart|br_(?:type|btn|media|confirm|scope)_[A-Za-z0-9_]+|admin-broadcast-(?:list|archive|manage|hub)\/.*)$/,
    async (ctx) => {
        await ctx.answerCallbackQuery({ text: "This screen is no longer available." }).catch(() => { });
    },
);
